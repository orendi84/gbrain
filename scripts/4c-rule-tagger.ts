/**
 * Step 4c rule-based tagger.
 *
 * Parses each gbrain `person` page's compiled_truth and extracts:
 *   - function:*           (product, engineering, sales, ...)
 *   - seniority:*          (ic, manager, senior_manager, director, vp, c_level, founder)
 *   - relationship_stage:* (unknown, prospect, peer, ...)
 *
 * Defers to Step 4f (Haiku):
 *   - firm_type:*          (needs a seed lookup + LLM fallback)
 *   - geo_country:*        (needs message scanning with LLM)
 *   - topic_interest:*     (sparse, LLM only)
 *
 * Modes:
 *   - --dry-run : prints per-person extraction for N samples, no DB writes.
 *   - --apply   : runs the extraction over ALL person pages and writes tags via INSERT
 *                 on the `tags` table (UNIQUE (page_id, tag) ON CONFLICT DO NOTHING).
 *
 * Usage:
 *   bun /tmp/4c-rule-tagger.ts --dry-run 30
 *   bun /tmp/4c-rule-tagger.ts --apply
 */

import postgres from 'postgres';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 30, connect_timeout: 15 });

// ──────────────────────────────────────────────────────────────
// Keyword mappings
// ──────────────────────────────────────────────────────────────

// Function: first match wins. Listed most specific → most general.
// Each entry: [function_value, regex patterns (case-insensitive)]
const FUNCTION_RULES: Array<[string, RegExp[]]> = [
  // Product has to come early so "Chief Product Officer" etc. hit product, not executive.
  ['product', [
    /\b(product manager|product owner|product lead|head of product|director product|director of product|vp product|cpo|product director|chief product officer|product marketing|product analyst|product ops|product operations|principal product|senior product|product designer)\b/i,
    /\bproduct\b/i,
  ]],
  ['engineering', [
    /\b(software engineer|software developer|software architect|back ?end|front ?end|full ?stack|swe|mobile engineer|mobile developer|staff engineer|principal engineer|distinguished engineer|engineer|developer|architect|devops|sre|tech lead|technical lead|technology leader|engineering manager|vp engineering|director engineering|head of engineering|chief technology officer|cto|programmer|qa engineer|test engineer|test lead|qa lead|reliability|tribe lead|tribe leader|squad lead)\b/i,
  ]],
  ['data_science', [
    /\b(data scientist|data engineer|ml engineer|machine learning|ai engineer|analytics engineer|head of data|vp data|director data|chief data officer|data architect|data analyst|analytics director|head of analytics|analytics lead|business intelligence|\bbi\b)\b/i,
    /\b(data|analytics)\b(?=.*(director|manager|head|lead))/i,
  ]],
  ['design', [
    /\b(designer|ux|ui designer|visual design|design lead|head of design|chief design|director design|design director)\b/i,
  ]],
  ['research', [
    /\b(research scientist|researcher|research lead|head of research|research director|chief research officer)\b/i,
  ]],
  ['presales', [
    /\b(presales|pre-sales|pre sales|solution consultant|solutions consultant|solutions architect|solutions engineer|sales engineer|solution engineer|solution architect|head of presales|director presales)\b/i,
  ]],
  ['customer_success', [
    /\b(customer success|csm|client success|customer experience|head of cs|account manager|relationship manager)\b/i,
  ]],
  ['partnerships', [
    /\b(partnership|alliances|channel manager|alliance|bd manager|strategic partnership|head of partnerships|director partnerships|channel director|alliance director)\b/i,
  ]],
  ['sales', [
    /\b(sales|account executive|bdr|sdr|business development|enterprise sales|inside sales|sales director|sales manager|head of sales|vp sales|cro|chief revenue officer|go-to-market|gtm|regional sales|country sales|sales operations)\b/i,
  ]],
  ['marketing', [
    /\b(marketing|brand manager|content marketing|growth marketing|demand gen|cmo|head of marketing|vp marketing|director marketing|marketing director|brand director|communications director|chief marketing|pr manager|public relations|content manager|event manager|internal communications|external communications|comms lead|communications specialist|copywriter)\b/i,
  ]],
  ['operations', [
    /\b(operations|operating|coo|chief operating officer|ops manager|business operations|biz ops|head of operations|operations director|director operations|program manager|project manager|project portfolio|portfolio manager|pmp|pmo|procurement|supply chain|logistics|agile coach|scrum master|team manager)\b/i,
  ]],
  ['compliance', [
    /\b(compliance|aml|kyc|risk manager|head of risk|audit|internal audit|regulatory|chief risk officer|cro risk|\bcro\b(?!.*(revenue|sales)))\b/i,
  ]],
  ['legal', [
    /\b(legal|general counsel|attorney|chief legal|corporate counsel|lawyer|gc\b)\b/i,
  ]],
  ['finance', [
    /\b(finance|controller|accounting|treasurer|cfo|chief financial officer|fp&a|financial analyst|financial advisor|financial planning|corporate finance|investment|wealth manager)\b/i,
  ]],
  ['hr', [
    /\b(\bhr\b|people operations|people ops|talent|recruiter|chro|head of people|people partner|human resources|people lead|chief people|people officer|people and productivity|l&d|learning and development)\b/i,
  ]],
  ['strategy', [
    /\b(strategy|strategist|corporate development|chief of staff|chief strategy officer|management consultant|principal consultant|senior consultant|consultant|business analyst|business development manager)\b/i,
  ]],
  // "Executive" catches the residual C-suite / founder / generalist leadership that didn't fit elsewhere.
  // Must come AFTER all specific functions so e.g. "CPO" hits product, not executive.
  ['executive', [
    /\b(ceo|chief executive|president|managing director|general manager|country manager|country head|regional director|regional head|head of region|head of country|co-?founder|founder\b|chairman|chairwoman|board member|owner|propriétaire|ügyvezető)\b/i,
    /\bhead of\b/i, // catch-all for generic "head of <X>" that didn't hit a specific function
  ]],
];

// Seniority: priority order top-to-bottom. First match wins.
const SENIORITY_RULES: Array<[string, RegExp]> = [
  ['founder', /\b(founder|co-?founder)\b/i],
  ['c_level', /\b(ceo|cto|coo|cfo|cmo|cro|cpo|chro|chief\b|president(?!\s+of\s+the\s+board))\b/i],
  ['svp', /\b(svp|senior vice president)\b/i],
  ['vp', /\b(\bvp\b|vice president|evp|executive vice president)\b/i],
  ['director', /\b(director|head of)\b/i],
  ['senior_manager', /\b(senior manager|lead\b|principal(?!\s+consultant)|staff engineer|managing consultant|senior consultant|senior engineer|senior developer|senior product|senior analyst|senior consultant)\b/i],
  ['manager', /\b(manager)\b/i],
];

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

function extractPositionAndCompany(compiled_truth: string): { position: string; company: string } | null {
  const lines = compiled_truth.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  // Line 1 is "# Name", line 2 is "<Position> at <Company>"
  const line2 = lines[1];
  // Use first " at " split. "Customer Success Manager Latam at Mambu at Mambu" → position: "Customer Success Manager Latam", company: "Mambu at Mambu"
  const idx = line2.toLowerCase().indexOf(' at ');
  if (idx === -1) return null;
  const position = line2.slice(0, idx).trim();
  const company = line2.slice(idx + 4).trim();
  return { position, company };
}

function classifyFunction(position: string): string | null {
  for (const [fn, patterns] of FUNCTION_RULES) {
    for (const pat of patterns) {
      if (pat.test(position)) return fn;
    }
  }
  return null;
}

function classifySeniority(position: string): string {
  for (const [level, pat] of SENIORITY_RULES) {
    if (pat.test(position)) return level;
  }
  return 'ic'; // default
}

function classifyRelationshipStage(compiled_truth: string): string {
  // Parse ## Messages section if present. Count "> **Gary Orendi**:" vs other senders.
  const msgIdx = compiled_truth.indexOf('## Messages');
  if (msgIdx === -1) return 'unknown';
  const msgSection = compiled_truth.slice(msgIdx);
  // Count Gary-authored messages
  const garyCount = (msgSection.match(/>\s*\*\*Gary Orendi\*\*:/g) || []).length;
  // Count total message entries (### timestamps)
  const totalCount = (msgSection.match(/^###\s+\d{4}-\d{2}-\d{2}/gm) || []).length;
  const otherCount = totalCount - garyCount;
  if (totalCount === 0) return 'unknown';
  if (garyCount >= 5 && otherCount >= 1) return 'peer';
  if (garyCount >= 1 && otherCount >= 1) return 'prospect';
  if (garyCount >= 1 && otherCount === 0) return 'unknown'; // just Gary's outreach, no reply
  return 'unknown';
}

// ──────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const sampleLimit = parseInt(args.find(a => /^\d+$/.test(a)) || '30', 10);

  if (!dryRun && !apply) {
    console.error('Usage: bun 4c-rule-tagger.ts --dry-run [N] | --apply');
    process.exit(1);
  }

  try {
    if (dryRun) {
      // Pull a random sample and print the proposed tags
      const rows = await sql<Array<{ id: number; slug: string; compiled_truth: string }>>`
        SELECT id, slug, compiled_truth
        FROM pages
        WHERE type='person' AND length(compiled_truth) > 50
        ORDER BY random()
        LIMIT ${sampleLimit}
      `;

      console.log(`Dry-run sample of ${rows.length} people:\n`);
      const stats = { function: {} as Record<string, number>, seniority: {} as Record<string, number>, relationship_stage: {} as Record<string, number>, no_position: 0 };
      for (const r of rows) {
        const parsed = extractPositionAndCompany(r.compiled_truth);
        if (!parsed) {
          console.log(`${r.slug}  [no position line]`);
          stats.no_position++;
          continue;
        }
        const fn = classifyFunction(parsed.position);
        const sen = classifySeniority(parsed.position);
        const rel = classifyRelationshipStage(r.compiled_truth);
        console.log(`${r.slug}`);
        console.log(`  position: ${parsed.position}`);
        console.log(`  company:  ${parsed.company}`);
        console.log(`  tags:     function:${fn ?? '?'}  seniority:${sen}  relationship_stage:${rel}`);
        console.log('');
        stats.function[fn ?? 'null'] = (stats.function[fn ?? 'null'] || 0) + 1;
        stats.seniority[sen] = (stats.seniority[sen] || 0) + 1;
        stats.relationship_stage[rel] = (stats.relationship_stage[rel] || 0) + 1;
      }
      console.log('--- Sample stats ---');
      console.log('function:', stats.function);
      console.log('seniority:', stats.seniority);
      console.log('relationship_stage:', stats.relationship_stage);
      console.log('no_position:', stats.no_position);
    }

    if (apply) {
      const rows = await sql<Array<{ id: number; slug: string; compiled_truth: string }>>`
        SELECT id, slug, compiled_truth
        FROM pages
        WHERE type='person'
      `;
      console.log(`Applying to ${rows.length} people...`);
      const tagRows: Array<{ page_id: number; tag: string }> = [];
      let noPosition = 0;
      const stats = { function: {} as Record<string, number>, seniority: {} as Record<string, number> };

      for (const r of rows) {
        const parsed = extractPositionAndCompany(r.compiled_truth);
        if (!parsed) {
          noPosition++;
          continue;
        }
        const fn = classifyFunction(parsed.position);
        const sen = classifySeniority(parsed.position);
        if (fn) {
          tagRows.push({ page_id: r.id, tag: `function:${fn}` });
          stats.function[fn] = (stats.function[fn] || 0) + 1;
        }
        tagRows.push({ page_id: r.id, tag: `seniority:${sen}` });
        stats.seniority[sen] = (stats.seniority[sen] || 0) + 1;
      }

      console.log(`Collected ${tagRows.length} tag rows. Writing in batches of 500.`);

      // Bulk insert in chunks to keep statement size sane
      const BATCH = 500;
      let written = 0;
      for (let i = 0; i < tagRows.length; i += BATCH) {
        const batch = tagRows.slice(i, i + BATCH);
        await sql`
          INSERT INTO tags ${sql(batch, 'page_id', 'tag')}
          ON CONFLICT (page_id, tag) DO NOTHING
        `;
        written += batch.length;
        if (written % 2000 === 0 || written === tagRows.length) {
          console.log(`  ${written}/${tagRows.length}`);
        }
      }

      console.log('--- Final stats ---');
      console.log('function:', stats.function);
      console.log('seniority:', stats.seniority);
      console.log('no_position:', noPosition);

      // Verify
      const countsCheck = await sql`
        SELECT
          count(*) FILTER (WHERE tag LIKE 'function:%')::int AS fn,
          count(*) FILTER (WHERE tag LIKE 'seniority:%')::int AS sen
        FROM tags
      `;
      console.log('DB verification (tags table):', countsCheck[0]);
    }
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
