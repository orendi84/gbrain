/**
 * Step 4f PRODUCTION run (people residual): classify all person pages with
 * Claude Haiku 4.5 via strict tool_use.
 *
 * Two passes:
 *   Pass A: firm_type on ALL real individuals (3,640 after excluding the legacy
 *           merged chunk blob). Tiny payload = title + headline line only.
 *   Pass B: geo_country + topic_interest on people with >=500 chars of
 *           compiled_truth (~657). Larger payload = title + first 2,000 chars.
 *
 * Both passes use strict tool_use with enum constraints. Tags written via bulk
 * INSERT with ON CONFLICT DO NOTHING. Resumable: skips pages that already have
 * the relevant tag.
 *
 * Kill brake: stops if total spend exceeds $10 (Pass B ~$0.66, Pass A ~$0.60,
 * combined plan estimate $1-2).
 *
 * Based on 4f-run-content.ts shape. Same retry, same cost math, same flush pattern.
 */

import postgres from 'postgres';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 4, idle_timeout: 30, connect_timeout: 15 });

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const PRICE_IN = 1.00;
const PRICE_OUT = 5.00;
const PRICE_CACHE_WRITE = 1.25;
const PRICE_CACHE_READ = 0.10;
const KILL_BRAKE_USD = 10.00;
const CONCURRENCY = 3;
const MAX_RETRIES = 5;
const PROGRESS_EVERY = 100;
const TAG_BATCH_SIZE = 150;

// ──────────────────────────────────────────────────────────────
// Taxonomy (from plan Step 4, locked 2026-04-11)
// ──────────────────────────────────────────────────────────────

const FIRM_TYPE_VALUES = [
  'bank', 'asset_manager', 'insurer',
  'payments', 'lending', 'fintech',
  'regulator', 'consultancy', 'vc',
  'saas', 'enterprise_tech',
  'media', 'retail', 'manufacturing',
  'healthcare', 'pharma', 'automotive',
  'energy', 'education', 'government',
  'nonprofit', 'other', 'unknown',
];

// Curated ISO 3166-1 alpha-2 set: ASEAN, APAC, Europe, Americas, MEA core.
// Plus 'unknown' for no-evidence case.
const GEO_COUNTRY_VALUES = [
  // ASEAN
  'SG', 'ID', 'MY', 'TH', 'VN', 'PH', 'MM', 'KH', 'LA', 'BN',
  // APAC
  'HK', 'CN', 'JP', 'KR', 'TW', 'IN', 'AU', 'NZ', 'PK', 'BD',
  // Europe
  'GB', 'DE', 'FR', 'NL', 'IE', 'CH', 'BE', 'LU', 'IT', 'ES',
  'PT', 'AT', 'PL', 'CZ', 'SK', 'RO', 'HU', 'HR', 'SI', 'BG',
  'SE', 'NO', 'DK', 'FI', 'IS', 'GR', 'CY', 'MT', 'EE', 'LV', 'LT',
  // Americas
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY',
  // MEA
  'AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IL', 'TR', 'JO', 'LB',
  'ZA', 'EG', 'KE', 'NG', 'MA', 'TN', 'GH',
  // fallback
  'unknown',
];

const TOPIC_INTEREST_VALUES = [
  'ai', 'banking_modernization', 'embedded_finance', 'open_banking',
  'digital_banking', 'payments', 'lending', 'wealth_management',
  'insurance', 'crypto', 'regtech', 'compliance',
  'sustainability', 'esg', 'b2b_saas', 'platform_strategy',
  'product_strategy', 'leadership', 'fundraising', 'entrepreneurship',
  'other',
];

const CLASSIFY_FIRM_TYPE_TOOL = {
  name: 'classify_firm_type',
  description: 'Classify a LinkedIn contact by the type of organization they work at. Pick the single most specific match from the enum.',
  input_schema: {
    type: 'object' as const,
    properties: {
      firm_type: {
        type: 'string',
        enum: FIRM_TYPE_VALUES,
        description: 'Type of organization. Prefer specific fintech categories (payments, lending, fintech) over broad ones (saas, enterprise_tech) when applicable. Use "unknown" when the headline is missing, generic, or ambiguous.',
      },
    },
    required: ['firm_type'],
    additionalProperties: false,
  },
  strict: true,
};

const CLASSIFY_GEO_TOPIC_TOOL = {
  name: 'classify_geo_topic',
  description: 'Classify a LinkedIn contact by location and topic interests based on their profile and message history. Pick one country code (or "unknown") and 0 or more topic interests (only when explicit evidence exists).',
  input_schema: {
    type: 'object' as const,
    properties: {
      geo_country: {
        type: 'string',
        enum: GEO_COUNTRY_VALUES,
        description: 'ISO 3166-1 alpha-2 country code based on explicit location signals in the headline or messages ("based in X", "moved to Y", "see you in Z"). Use "unknown" when no explicit signal exists.',
      },
      topic_interests: {
        type: 'array',
        items: { type: 'string', enum: TOPIC_INTEREST_VALUES },
        description: 'Topics the person has explicitly discussed or shown interest in via their messages or profile headline. Empty array if no explicit signal. Do NOT infer from role alone - requires explicit evidence. Typically 0-3 values.',
      },
    },
    required: ['geo_country', 'topic_interests'],
    additionalProperties: false,
  },
  strict: true,
};

const FIRM_TYPE_SYSTEM = `You classify LinkedIn contacts by the type of organization they work at. Call the classify_firm_type tool with exactly one value from the enum.

Input shape: a name and a headline like "Position at Company".
Rules:
- Pick the most specific fintech category when applicable: "payments", "lending", "fintech" beat "saas" or "enterprise_tech".
- "bank" is a regulated deposit-taking institution, not a fintech startup.
- "saas" = software vendor selling to businesses, non-fintech. "fintech" = software vendor in financial services.
- "consultancy" = professional services firm (McKinsey, Accenture, Deloitte). Individual freelancers = "consultancy".
- "vc" = venture capital / private equity / angel funds.
- "unknown" when the headline is missing, vague ("Seeking opportunities"), or the company is too obscure to guess.`;

const GEO_TOPIC_SYSTEM = `You classify LinkedIn contacts by geographic location and topic interests based on their profile and message history. Call the classify_geo_topic tool once.

Rules for geo_country (STRICT - personal location only):
- Use ISO 3166-1 alpha-2 codes only (from the enum).
- You need EXPLICIT PERSONAL location signals about where the contact physically lives or works from. Examples that count:
  * "based in Singapore", "I'm in Jakarta", "moved to London", "lives in Berlin"
  * "catch up when I'm in Bangkok", "flying back to Dublin tomorrow"
  * Headline fragments like "Singapore" or "Jakarta office" tied to the person's role
- The following are NOT enough - return "unknown" for these:
  * Company headquarters location. "MOL Group" is a Hungarian company but the contact may work in any office. Do NOT return HU for an MOL Group employee unless personal location is independently stated.
  * "Vision Bank" being a Saudi bank does NOT mean the contact is in SA.
  * Regional role descriptions ("Head of APAC", "EMEA Sales"). Regional does not pin a country.
  * Company country of incorporation.
- When in doubt, return "unknown". False precision is worse than a gap.

Rules for topic_interests (RELAXED - role + profile signal allowed):
- Include topics the person has discussed in messages OR topics directly implied by their role, profile headline, or "About" section.
- Role-based inference is fine: "Head of Payments at Mambu" → payments. "Engineering Leadership" → leadership. "Open Banking Consultant" → open_banking.
- Multiple topics per person are fine. Typical range: 0-3 topics.
- Auto-generated welcome messages ("Welcome to Lenny's podcast community") do NOT count as signal.
- Empty array is correct when the role is too generic to pin (e.g. "Operations Manager", "Product Manager" without further context).`;

// ──────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────

type Page = { id: number; slug: string; title: string; compiled_truth: string };
type FirmResult = { pageId: number; firmType: string | null; usage: any; error?: string };
type GeoTopicResult = { pageId: number; geoCountry: string | null; topics: string[]; usage: any; error?: string };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callAnthropic(system: string, tool: any, userContent: string): Promise<{ data: any; status: number }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': cfg.anthropic_api_key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: HAIKU_MODEL,
          max_tokens: 200,
          system,
          tools: [tool],
          tool_choice: { type: 'any' },
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      const data = await resp.json() as any;
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < MAX_RETRIES - 1) {
          await sleep(Math.min(1000 * Math.pow(2, attempt), 15000));
          continue;
        }
      }
      return { data, status: resp.status };
    } catch (e: any) {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return { data: { error: { message: e.message } }, status: 0 };
    }
  }
  return { data: { error: { message: 'exhausted retries' } }, status: 0 };
}

async function classifyFirmType(page: Page): Promise<FirmResult> {
  // Payload = first 2 lines only. That's "# Name" and the headline line.
  const lines = (page.compiled_truth || '').split('\n').slice(0, 2).join('\n');
  const userContent = `Title: ${page.title}\n\n${lines}`;

  const { data, status } = await callAnthropic(FIRM_TYPE_SYSTEM, CLASSIFY_FIRM_TYPE_TOOL, userContent);

  if (status === 0 || status >= 400) {
    return { pageId: page.id, firmType: null, usage: data.usage || {}, error: `API ${status}: ${JSON.stringify(data).slice(0, 200)}` };
  }
  const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
  if (!toolUse) return { pageId: page.id, firmType: null, usage: data.usage, error: 'no tool_use' };
  return { pageId: page.id, firmType: toolUse.input?.firm_type, usage: data.usage };
}

async function classifyGeoTopic(page: Page): Promise<GeoTopicResult> {
  const excerpt = (page.compiled_truth || '').slice(0, 2000);
  const userContent = `Title: ${page.title}\n\nProfile:\n${excerpt}`;

  const { data, status } = await callAnthropic(GEO_TOPIC_SYSTEM, CLASSIFY_GEO_TOPIC_TOOL, userContent);

  if (status === 0 || status >= 400) {
    return { pageId: page.id, geoCountry: null, topics: [], usage: data.usage || {}, error: `API ${status}: ${JSON.stringify(data).slice(0, 200)}` };
  }
  const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
  if (!toolUse) return { pageId: page.id, geoCountry: null, topics: [], usage: data.usage, error: 'no tool_use' };
  return {
    pageId: page.id,
    geoCountry: toolUse.input?.geo_country,
    topics: Array.isArray(toolUse.input?.topic_interests) ? toolUse.input.topic_interests : [],
    usage: data.usage,
  };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 4f people residual — firm_type (all) + geo_country + topic_interest (>=500 chars)\n');

  const totals = {
    input: 0, output: 0, cache_write: 0, cache_read: 0,
    passA_success: 0, passA_errors: 0,
    passB_success: 0, passB_errors: 0,
  };
  const pendingTags: Array<{ page_id: number; tag: string }> = [];
  const errorLog: Array<{ pass: string; slug: string; error: string }> = [];
  const startTime = Date.now();
  let killed = false;

  async function flushTags() {
    while (pendingTags.length >= TAG_BATCH_SIZE) {
      const batch = pendingTags.splice(0, TAG_BATCH_SIZE);
      await sql`
        INSERT INTO tags ${sql(batch, 'page_id', 'tag')}
        ON CONFLICT (page_id, tag) DO NOTHING
      `;
    }
  }

  function currCost() {
    return (totals.input / 1e6) * PRICE_IN
      + (totals.output / 1e6) * PRICE_OUT
      + (totals.cache_write / 1e6) * PRICE_CACHE_WRITE
      + (totals.cache_read / 1e6) * PRICE_CACHE_READ;
  }

  // ──────────────────────────────────────────────────────────────
  // PASS A: firm_type on all real individuals (excluding the merged chunk)
  // Resumable: skip any page that already has a firm_type tag.
  // ──────────────────────────────────────────────────────────────
  const passAPages = await sql<Page[]>`
    SELECT p.id, p.slug, p.title, p.compiled_truth
    FROM pages p
    WHERE p.type = 'person'
      AND p.slug NOT LIKE 'people/chunks%'
      AND NOT EXISTS (
        SELECT 1 FROM tags t
        WHERE t.page_id = p.id AND t.tag LIKE 'firm_type:%'
      )
    ORDER BY p.id
  `;

  console.log(`PASS A (firm_type on all individuals)`);
  console.log(`  Pages to classify: ${passAPages.length}`);
  console.log(`  Payload: title + headline line (~50 tokens)`);
  console.log(`  Concurrency: ${CONCURRENCY}\n`);

  for (let i = 0; i < passAPages.length; i += CONCURRENCY) {
    const chunk = passAPages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(classifyFirmType));

    for (const r of results) {
      totals.input += r.usage?.input_tokens || 0;
      totals.output += r.usage?.output_tokens || 0;
      totals.cache_write += r.usage?.cache_creation_input_tokens || 0;
      totals.cache_read += r.usage?.cache_read_input_tokens || 0;

      if (r.error || !r.firmType) {
        totals.passA_errors++;
        const p = passAPages.find(p => p.id === r.pageId);
        errorLog.push({ pass: 'A', slug: p?.slug || String(r.pageId), error: r.error || 'unknown' });
        continue;
      }
      totals.passA_success++;
      pendingTags.push({ page_id: r.pageId, tag: `firm_type:${r.firmType}` });
    }

    await flushTags();

    const done = i + chunk.length;
    if (done % PROGRESS_EVERY === 0 || done === passAPages.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = done / elapsed;
      const eta = (passAPages.length - done) / rate;
      console.log(`  A ${done}/${passAPages.length} (${((done/passAPages.length)*100).toFixed(1)}%)  success=${totals.passA_success} errors=${totals.passA_errors}  cost=$${currCost().toFixed(4)}  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s`);
    }

    if (currCost() > KILL_BRAKE_USD) {
      console.log(`\n!!! KILL BRAKE TRIGGERED: $${currCost().toFixed(2)} exceeds $${KILL_BRAKE_USD} !!!`);
      killed = true;
      break;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // PASS B: geo_country + topic_interest on people with >=500 chars
  // Resumable: skip any page that already has BOTH a geo_country tag AND
  // at least has been marked (zero or more topic_interest tags).
  // Simpler resumability: skip if geo_country already set (geo is always set).
  // ──────────────────────────────────────────────────────────────
  if (!killed) {
    const passBPages = await sql<Page[]>`
      SELECT p.id, p.slug, p.title, p.compiled_truth
      FROM pages p
      WHERE p.type = 'person'
        AND p.slug NOT LIKE 'people/chunks%'
        AND length(p.compiled_truth) >= 500
        AND NOT EXISTS (
          SELECT 1 FROM tags t
          WHERE t.page_id = p.id AND t.tag LIKE 'geo_country:%'
        )
      ORDER BY p.id
    `;

    console.log(`\nPASS B (geo_country + topic_interest on people with messages)`);
    console.log(`  Pages to classify: ${passBPages.length}`);
    console.log(`  Payload: title + first 2000 chars of compiled_truth`);
    console.log(`  Concurrency: ${CONCURRENCY}\n`);

    for (let i = 0; i < passBPages.length; i += CONCURRENCY) {
      const chunk = passBPages.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(classifyGeoTopic));

      for (const r of results) {
        totals.input += r.usage?.input_tokens || 0;
        totals.output += r.usage?.output_tokens || 0;
        totals.cache_write += r.usage?.cache_creation_input_tokens || 0;
        totals.cache_read += r.usage?.cache_read_input_tokens || 0;

        if (r.error || !r.geoCountry) {
          totals.passB_errors++;
          const p = passBPages.find(p => p.id === r.pageId);
          errorLog.push({ pass: 'B', slug: p?.slug || String(r.pageId), error: r.error || 'unknown' });
          continue;
        }
        totals.passB_success++;
        pendingTags.push({ page_id: r.pageId, tag: `geo_country:${r.geoCountry}` });
        for (const topic of r.topics) {
          pendingTags.push({ page_id: r.pageId, tag: `topic_interest:${topic}` });
        }
      }

      await flushTags();

      const done = i + chunk.length;
      if (done % PROGRESS_EVERY === 0 || done === passBPages.length) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = (done) / elapsed;
        const eta = (passBPages.length - done) / rate;
        console.log(`  B ${done}/${passBPages.length} (${((done/passBPages.length)*100).toFixed(1)}%)  success=${totals.passB_success} errors=${totals.passB_errors}  cost=$${currCost().toFixed(4)}  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s`);
      }

      if (currCost() > KILL_BRAKE_USD) {
        console.log(`\n!!! KILL BRAKE TRIGGERED: $${currCost().toFixed(2)} exceeds $${KILL_BRAKE_USD} !!!`);
        killed = true;
        break;
      }
    }
  }

  // Flush remaining
  if (pendingTags.length > 0) {
    console.log(`\nFlushing final ${pendingTags.length} tag rows...`);
    while (pendingTags.length > 0) {
      const batch = pendingTags.splice(0, TAG_BATCH_SIZE);
      await sql`
        INSERT INTO tags ${sql(batch, 'page_id', 'tag')}
        ON CONFLICT (page_id, tag) DO NOTHING
      `;
    }
  }

  // Final report
  const finalCost = currCost();
  const elapsed = (Date.now() - startTime) / 1000;

  console.log('\n' + '═'.repeat(70));
  console.log(killed ? 'KILL BRAKE - run interrupted' : 'Run complete');
  console.log('═'.repeat(70));
  console.log(`Pass A firm_type:  success=${totals.passA_success} errors=${totals.passA_errors}`);
  console.log(`Pass B geo+topic:  success=${totals.passB_success} errors=${totals.passB_errors}`);
  console.log(`Elapsed: ${elapsed.toFixed(0)}s (${(elapsed/60).toFixed(1)} min)`);
  console.log(`\nToken usage:`);
  console.log(`  input:       ${totals.input.toLocaleString()}`);
  console.log(`  output:      ${totals.output.toLocaleString()}`);
  console.log(`\nCost:`);
  console.log(`  input:       $${((totals.input / 1e6) * PRICE_IN).toFixed(4)}`);
  console.log(`  output:      $${((totals.output / 1e6) * PRICE_OUT).toFixed(4)}`);
  console.log(`  TOTAL:       $${finalCost.toFixed(4)}`);

  if (errorLog.length > 0) {
    console.log(`\nFirst 10 errors:`);
    for (const e of errorLog.slice(0, 10)) {
      console.log(`  [${e.pass}] ${e.slug}: ${e.error.slice(0, 100)}`);
    }
    fs.writeFileSync('/tmp/4f-people-errors.json', JSON.stringify(errorLog, null, 2));
    console.log(`Full error log: /tmp/4f-people-errors.json`);
  }

  // Verify DB state
  const check = await sql`
    SELECT
      count(*) FILTER (WHERE tag LIKE 'firm_type:%')::int AS ft,
      count(*) FILTER (WHERE tag LIKE 'geo_country:%')::int AS gc,
      count(*) FILTER (WHERE tag LIKE 'topic_interest:%')::int AS ti
    FROM tags
  `;
  console.log(`\nDB tags (cumulative): firm_type=${check[0].ft}  geo_country=${check[0].gc}  topic_interest=${check[0].ti}`);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
