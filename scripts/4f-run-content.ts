/**
 * Step 4f PRODUCTION run: classify all content pages with Claude Haiku 4.5
 * via strict tool_use.
 *
 * Based on canary v5 approach (zero hallucinations confirmed):
 *   - strict: true tool with enum constraints
 *   - tool_choice: {"type": "any"}
 *   - additionalProperties: false
 *   - Full-label enums, no ID mapping
 *
 * Writes tags to the `tags` table via bulk INSERT with ON CONFLICT DO NOTHING.
 * Resumable: skips pages that already have domain:*, theme:*, or audience:* tags.
 *
 * Kill brake: stops if total spend exceeds $25.
 * Concurrency: 5 requests in flight at a time.
 * Progress: logs every 100 pages with running cost.
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
const KILL_BRAKE_USD = 25.00;
const CONCURRENCY = 3;
const MAX_RETRIES = 5;
const PROGRESS_EVERY = 100;
const TAG_BATCH_SIZE = 150;

// ──────────────────────────────────────────────────────────────
// Taxonomy (locked from 4d / verified in canary v5)
// ──────────────────────────────────────────────────────────────

const DOMAIN_VALUES = [
  'fintech', 'banking', 'payments', 'b2b_saas', 'enterprise_software',
  'consumer_tech', 'ai_ml', 'data_analytics', 'cybersecurity', 'health',
  'neuroscience', 'science', 'education', 'media_entertainment', 'retail_ecommerce',
  'sustainability_energy', 'policy_regulation', 'culture_arts', 'history', 'none',
];

const THEME_VALUES = [
  'product_strategy', 'go_to_market', 'business_model', 'innovation', 'growth',
  'pricing', 'distribution', 'customer_success',
  'leadership', 'management', 'org_design', 'culture', 'hiring_talent',
  'change_management', 'trust',
  'decision_making', 'communication', 'productivity', 'focus', 'burnout',
  'resilience', 'career', 'learning', 'mindset',
  'ai_adoption', 'data_strategy', 'engineering_practice', 'automation',
  'health_longevity', 'sleep_recovery', 'psychology', 'habits', 'creativity',
  'other',
];

const AUDIENCE_VALUES = [
  'founders', 'operators', 'product_managers', 'engineers', 'designers',
  'sales_leaders', 'executives', 'investors', 'advisors_consultants',
  'bank_execs', 'general', 'other',
];

const CLASSIFY_TOOL = {
  name: 'classify_page',
  description: 'Classify a content page into one domain, one theme, and one audience. Pick the single most dominant value per dimension.',
  input_schema: {
    type: 'object' as const,
    properties: {
      domain: {
        type: 'string',
        enum: DOMAIN_VALUES,
        description: 'Sector the content discusses. Use "none" when content is purely theme-driven with no sector anchor (productivity talk, book on habits).',
      },
      theme: {
        type: 'string',
        enum: THEME_VALUES,
        description: 'Primary transferable cross-cutting topic. Use "other" only for pure entertainment / folklore / poetry with no transferable theme.',
      },
      audience: {
        type: 'string',
        enum: AUDIENCE_VALUES,
        description: 'Who the content is FOR. Use "general" for broad-public content (most TED talks, Huberman Lab, general-interest books).',
      },
    },
    required: ['domain', 'theme', 'audience'],
    additionalProperties: false,
  },
  strict: true,
};

const SYSTEM_PROMPT = `You classify content pages for a fintech advisor's personal knowledge brain. Call the classify_page tool with exactly one value per dimension from the enum. The schema enforces the valid values - invalid ones are rejected.

Rules:
- Be decisive. Pick the single most dominant value per dimension.
- Prefer more specific values when torn: "neuroscience" beats "science" for Huberman Lab. "fintech" beats "banking" for a fintech startup. "b2b_saas" beats "enterprise_software" for a SaaS podcast.
- Domain and theme are separate dimensions. Psychology is a theme, never a domain. Pick a health or education or none domain separately.
- Most general-public content uses audience "general". Reserve specific audiences for content clearly targeted at one professional group.
- Use theme "other" only when content has no transferable theme (folklore, riddles, pure art).`;

// ──────────────────────────────────────────────────────────────
// Classification
// ──────────────────────────────────────────────────────────────

type Page = { id: number; slug: string; title: string; compiled_truth: string };
type Classification = { domain: string; theme: string; audience: string };
type Result = { pageId: number; classification: Classification | null; usage: any; error?: string };

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function classify(page: Page): Promise<Result> {
  const excerpt = (page.compiled_truth || '').slice(0, 800);
  const userContent = `Title: ${page.title}\n\nExcerpt:\n${excerpt}`;

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
          max_tokens: 150,
          system: SYSTEM_PROMPT,
          tools: [CLASSIFY_TOOL],
          tool_choice: { type: 'any' },
          messages: [{ role: 'user', content: userContent }],
        }),
      });

      const data = await resp.json() as any;

      // Retry on 429 (rate limit) or 5xx (server error)
      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < MAX_RETRIES - 1) {
          const backoff = Math.min(1000 * Math.pow(2, attempt), 15000); // 1s, 2s, 4s, 8s, 15s
          await sleep(backoff);
          continue;
        }
        return { pageId: page.id, classification: null, usage: data.usage || {}, error: `API ${resp.status} after ${MAX_RETRIES} retries` };
      }

      if (!resp.ok) {
        return { pageId: page.id, classification: null, usage: data.usage || {}, error: `API ${resp.status}: ${JSON.stringify(data).slice(0,200)}` };
      }
      const toolUse = (data.content || []).find((c: any) => c.type === 'tool_use');
      if (!toolUse) {
        return { pageId: page.id, classification: null, usage: data.usage, error: 'no tool_use in response' };
      }
      return {
        pageId: page.id,
        classification: {
          domain: toolUse.input?.domain,
          theme: toolUse.input?.theme,
          audience: toolUse.input?.audience,
        },
        usage: data.usage,
      };
    } catch (e: any) {
      // Network error: retry
      if (attempt < MAX_RETRIES - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return { pageId: page.id, classification: null, usage: {}, error: `fetch error: ${e.message}` };
    }
  }
  return { pageId: page.id, classification: null, usage: {}, error: 'exhausted retries' };
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  console.log('Step 4f production run — classifying content pages with Haiku 4.5\n');

  // Figure out which pages still need classification.
  // Skip any page that already has domain:*, theme:*, or audience:* tags (resumability).
  const pages = await sql<Page[]>`
    SELECT p.id, p.slug, p.title, p.compiled_truth
    FROM pages p
    WHERE p.type IN ('concept', 'knowledge')
      AND NOT EXISTS (
        SELECT 1 FROM tags t
        WHERE t.page_id = p.id
          AND (t.tag LIKE 'domain:%' OR t.tag LIKE 'theme:%' OR t.tag LIKE 'audience:%')
      )
    ORDER BY p.id
  `;
  console.log(`Pages to classify: ${pages.length}`);

  const alreadyDone = await sql<Array<{ n: number }>>`
    SELECT count(DISTINCT page_id)::int AS n FROM tags
    WHERE tag LIKE 'domain:%' OR tag LIKE 'theme:%' OR tag LIKE 'audience:%'
  `;
  console.log(`Already tagged: ${alreadyDone[0].n}`);
  console.log(`Total content pages: 9,273`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Kill brake: $${KILL_BRAKE_USD}`);
  console.log(`Starting...\n`);

  const totals = { input: 0, output: 0, cache_write: 0, cache_read: 0, errors: 0, success: 0 };
  const pendingTags: Array<{ page_id: number; tag: string }> = [];
  const errorLog: Array<{ slug: string; error: string }> = [];
  const startTime = Date.now();
  let killed = false;

  // Process in chunks with bounded concurrency
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    const chunk = pages.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(classify));

    for (const r of results) {
      totals.input += r.usage?.input_tokens || 0;
      totals.output += r.usage?.output_tokens || 0;
      totals.cache_write += r.usage?.cache_creation_input_tokens || 0;
      totals.cache_read += r.usage?.cache_read_input_tokens || 0;

      if (r.error || !r.classification) {
        totals.errors++;
        const page = pages.find(p => p.id === r.pageId);
        errorLog.push({ slug: page?.slug || String(r.pageId), error: r.error || 'unknown' });
        continue;
      }

      totals.success++;
      pendingTags.push({ page_id: r.pageId, tag: `domain:${r.classification.domain}` });
      pendingTags.push({ page_id: r.pageId, tag: `theme:${r.classification.theme}` });
      pendingTags.push({ page_id: r.pageId, tag: `audience:${r.classification.audience}` });
    }

    // Flush tag buffer every TAG_BATCH_SIZE
    while (pendingTags.length >= TAG_BATCH_SIZE) {
      const batch = pendingTags.splice(0, TAG_BATCH_SIZE);
      await sql`
        INSERT INTO tags ${sql(batch, 'page_id', 'tag')}
        ON CONFLICT (page_id, tag) DO NOTHING
      `;
    }

    // Cost + progress
    const currCost = (totals.input / 1e6) * PRICE_IN
      + (totals.output / 1e6) * PRICE_OUT
      + (totals.cache_write / 1e6) * PRICE_CACHE_WRITE
      + (totals.cache_read / 1e6) * PRICE_CACHE_READ;

    const done = i + chunk.length;
    if (done % PROGRESS_EVERY === 0 || done === pages.length) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = done / elapsed;
      const eta = (pages.length - done) / rate;
      console.log(`  ${done}/${pages.length} (${((done/pages.length)*100).toFixed(1)}%)  success=${totals.success} errors=${totals.errors}  cost=$${currCost.toFixed(4)}  elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s`);
    }

    if (currCost > KILL_BRAKE_USD) {
      console.log(`\n!!! KILL BRAKE TRIGGERED: $${currCost.toFixed(2)} exceeds $${KILL_BRAKE_USD} !!!`);
      console.log(`Stopping run. Processed ${done}/${pages.length}.`);
      killed = true;
      break;
    }
  }

  // Flush remaining tags
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
  const finalCost = (totals.input / 1e6) * PRICE_IN
    + (totals.output / 1e6) * PRICE_OUT
    + (totals.cache_write / 1e6) * PRICE_CACHE_WRITE
    + (totals.cache_read / 1e6) * PRICE_CACHE_READ;
  const elapsed = (Date.now() - startTime) / 1000;

  console.log('\n' + '═'.repeat(70));
  console.log(killed ? 'KILL BRAKE - run interrupted' : 'Run complete');
  console.log('═'.repeat(70));
  console.log(`Success: ${totals.success}`);
  console.log(`Errors:  ${totals.errors}`);
  console.log(`Elapsed: ${elapsed.toFixed(0)}s (${(elapsed/60).toFixed(1)} min)`);
  console.log(`\nToken usage:`);
  console.log(`  input:       ${totals.input.toLocaleString()}`);
  console.log(`  cache write: ${totals.cache_write.toLocaleString()}`);
  console.log(`  cache read:  ${totals.cache_read.toLocaleString()}`);
  console.log(`  output:      ${totals.output.toLocaleString()}`);
  console.log(`\nCost:`);
  console.log(`  input:       $${((totals.input / 1e6) * PRICE_IN).toFixed(4)}`);
  console.log(`  cache write: $${((totals.cache_write / 1e6) * PRICE_CACHE_WRITE).toFixed(4)}`);
  console.log(`  cache read:  $${((totals.cache_read / 1e6) * PRICE_CACHE_READ).toFixed(4)}`);
  console.log(`  output:      $${((totals.output / 1e6) * PRICE_OUT).toFixed(4)}`);
  console.log(`  TOTAL:       $${finalCost.toFixed(4)}`);

  if (errorLog.length > 0) {
    console.log(`\nFirst 10 errors:`);
    for (const e of errorLog.slice(0, 10)) {
      console.log(`  ${e.slug}: ${e.error.slice(0, 100)}`);
    }
    // Save full error log for inspection
    fs.writeFileSync('/tmp/4f-errors.json', JSON.stringify(errorLog, null, 2));
    console.log(`Full error log: /tmp/4f-errors.json`);
  }

  // Verify DB state
  const check = await sql`
    SELECT
      count(*) FILTER (WHERE tag LIKE 'domain:%')::int AS d,
      count(*) FILTER (WHERE tag LIKE 'theme:%')::int AS t,
      count(*) FILTER (WHERE tag LIKE 'audience:%')::int AS a
    FROM tags
  `;
  console.log(`\nDB tags (cumulative): domain=${check[0].d}  theme=${check[0].t}  audience=${check[0].a}`);

  await sql.end();
}

main().catch(e => { console.error(e); process.exit(1); });
