/**
 * Step 4f people residual CANARY — read-only sample classification.
 *
 * Samples 10 people for Pass A (firm_type, <500 chars) and 10 for Pass B
 * (geo + topic, >=500 chars), calls the classifiers, and prints the results
 * as a review table. Does NOT write anything to the DB.
 *
 * Purpose: sanity-check the prompts and taxonomy before bulk run.
 */

import postgres from 'postgres';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 10, connect_timeout: 15 });

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 3;

// Same taxonomies as the bulk script
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

const GEO_COUNTRY_VALUES = [
  'SG', 'ID', 'MY', 'TH', 'VN', 'PH', 'MM', 'KH', 'LA', 'BN',
  'HK', 'CN', 'JP', 'KR', 'TW', 'IN', 'AU', 'NZ', 'PK', 'BD',
  'GB', 'DE', 'FR', 'NL', 'IE', 'CH', 'BE', 'LU', 'IT', 'ES',
  'PT', 'AT', 'PL', 'CZ', 'SK', 'RO', 'HU', 'HR', 'SI', 'BG',
  'SE', 'NO', 'DK', 'FI', 'IS', 'GR', 'CY', 'MT', 'EE', 'LV', 'LT',
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY',
  'AE', 'SA', 'QA', 'BH', 'KW', 'OM', 'IL', 'TR', 'JO', 'LB',
  'ZA', 'EG', 'KE', 'NG', 'MA', 'TN', 'GH',
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

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callAnthropic(system: string, tool: any, userContent: string) {
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
        if (attempt < MAX_RETRIES - 1) { await sleep(2000 * (attempt + 1)); continue; }
      }
      return { data, status: resp.status };
    } catch (e: any) {
      if (attempt < MAX_RETRIES - 1) { await sleep(2000 * (attempt + 1)); continue; }
      return { data: { error: { message: e.message } }, status: 0 };
    }
  }
  return { data: { error: { message: 'exhausted retries' } }, status: 0 };
}

type Page = { id: number; slug: string; title: string; compiled_truth: string };

async function classifyFirmType(page: Page) {
  const lines = (page.compiled_truth || '').split('\n').slice(0, 2).join('\n');
  const userContent = `Title: ${page.title}\n\n${lines}`;
  const { data, status } = await callAnthropic(FIRM_TYPE_SYSTEM, CLASSIFY_FIRM_TYPE_TOOL, userContent);
  if (status !== 200) return { firmType: null, raw: data, headline: lines };
  const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
  return { firmType: toolUse?.input?.firm_type || null, raw: data, headline: lines };
}

async function classifyGeoTopic(page: Page) {
  const excerpt = (page.compiled_truth || '').slice(0, 2000);
  const userContent = `Title: ${page.title}\n\nProfile:\n${excerpt}`;
  const { data, status } = await callAnthropic(GEO_TOPIC_SYSTEM, CLASSIFY_GEO_TOPIC_TOOL, userContent);
  if (status !== 200) return { geoCountry: null, topics: [], raw: data, excerpt };
  const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
  return {
    geoCountry: toolUse?.input?.geo_country || null,
    topics: Array.isArray(toolUse?.input?.topic_interests) ? toolUse.input.topic_interests : [],
    raw: data,
    excerpt,
  };
}

async function main() {
  console.log('Step 4f people residual CANARY (read-only, 10 from each pass)\n');

  // Sample for Pass A: 10 random people with <500 chars, no firm_type tag
  const passASample = await sql<Page[]>`
    SELECT p.id, p.slug, p.title, p.compiled_truth
    FROM pages p
    WHERE p.type = 'person'
      AND p.slug NOT LIKE 'people/chunks%'
      AND length(p.compiled_truth) < 500
    ORDER BY random()
    LIMIT 10
  `;

  console.log('━'.repeat(70));
  console.log('PASS A CANARY — firm_type (10 random people, headline only)');
  console.log('━'.repeat(70));

  for (const p of passASample) {
    const result = await classifyFirmType(p);
    console.log(`\n[${p.slug}]`);
    console.log(`  Headline: ${result.headline.replace(/\n/g, ' | ')}`);
    console.log(`  → firm_type: ${result.firmType || '(FAILED: ' + JSON.stringify(result.raw).slice(0, 100) + ')'}`);
  }

  // Sample for Pass B: 10 random people with >=500 chars
  const passBSample = await sql<Page[]>`
    SELECT p.id, p.slug, p.title, p.compiled_truth
    FROM pages p
    WHERE p.type = 'person'
      AND p.slug NOT LIKE 'people/chunks%'
      AND length(p.compiled_truth) >= 500
    ORDER BY random()
    LIMIT 10
  `;

  console.log('\n' + '━'.repeat(70));
  console.log('PASS B CANARY — geo_country + topic_interest (10 random people with messages)');
  console.log('━'.repeat(70));

  for (const p of passBSample) {
    const result = await classifyGeoTopic(p);
    console.log(`\n[${p.slug}]`);
    // Show just the first 150 chars of excerpt so the review is compact
    const preview = result.excerpt.replace(/\n/g, ' | ').slice(0, 200);
    console.log(`  Preview: ${preview}...`);
    console.log(`  → geo_country: ${result.geoCountry || '(FAILED)'}`);
    console.log(`  → topic_interests: ${result.topics.length > 0 ? result.topics.join(', ') : '(none)'}`);
  }

  console.log('\nCanary complete. No DB writes made.');
  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
