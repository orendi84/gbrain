/**
 * Step 4c content rule-tagger.
 *
 * Classifies concept / knowledge pages with deterministic rules:
 *   - content_type:*   (youtube_transcript, book_summary, substack_article, linkedin_*)
 *   - source_channel:* (YouTube only, from slug prefix)
 *   - format:*         (YouTube only, from title patterns)
 *
 * Pages with type='concept' AND slug prefix in the 12 YouTube channel slugs:
 *   → content_type:youtube_transcript, source_channel:<channel>, format:<inferred>
 *
 * Pages with type='concept' AND slug prefix in the 5 LinkedIn content families:
 *   → content_type:linkedin_content (generic; leave finer split to 4f if needed)
 *
 * Pages with type='concept' AND neither of the above:
 *   → content_type:book_summary
 *
 * Pages with type='knowledge':
 *   → content_type:substack_article
 */

import postgres from 'postgres';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 30, connect_timeout: 15 });

const YT_CHANNELS = [
  'big-think', 'dwarkesh-patel', 'erdekes', 'huberman-lab', 'lennys-podcast',
  'lex-friedman', 'simon-sinek', 'startalk', 'ted-talks', 'ted-ed-originals',
  'pragmatic-engineer', '_standalone',
];

const LI_CONTENT_PREFIXES = ['people/chunks', 'content/', 'profile/', 'network/', 'activity/'];

function youtubeFormat(title: string, channel: string): string {
  const t = title.toLowerCase();
  // Channel-based defaults
  const channelDefault: Record<string, string> = {
    'huberman-lab': 'solo_episode',
    'ted-talks': 'lecture',
    'ted-ed-originals': 'lecture',
    'big-think': 'lecture',
    'startalk': 'panel',
    'dwarkesh-patel': 'interview',
    'lex-friedman': 'interview',
    'lennys-podcast': 'interview',
    'pragmatic-engineer': 'interview',
    'simon-sinek': 'solo_episode',
    'erdekes': 'other',
    '_standalone': 'other',
  };
  // Title-pattern overrides
  if (/podcast|interview|in conversation|with\s+\w+|episode\s*#?\d+/i.test(title)) return 'interview';
  if (/\bted\b/i.test(title)) return 'lecture';
  if (/panel|roundtable|debate/i.test(title)) return 'panel';
  if (/ama|q&a|q\s+and\s+a/i.test(title)) return 'qna';
  if (/lecture|talk/i.test(title) && channel !== 'lennys-podcast') return 'lecture';
  return channelDefault[channel] || 'other';
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  if (!dryRun && !apply) {
    console.error('Usage: bun 4c-content-tagger.ts --dry-run | --apply');
    process.exit(1);
  }

  try {
    const rows = await sql<Array<{ id: number; slug: string; type: string; title: string }>>`
      SELECT id, slug, type, title FROM pages WHERE type IN ('concept', 'knowledge')
    `;
    console.log(`Processing ${rows.length} concept+knowledge pages`);

    const tagRows: Array<{ page_id: number; tag: string }> = [];
    const stats = {
      content_type: {} as Record<string, number>,
      source_channel: {} as Record<string, number>,
      format: {} as Record<string, number>,
    };

    for (const r of rows) {
      let contentType: string;
      let channel: string | null = null;
      let format: string | null = null;

      if (r.type === 'knowledge') {
        contentType = 'substack_article';
      } else {
        // type='concept'
        const ytChan = YT_CHANNELS.find(c => r.slug.startsWith(c + '/'));
        if (ytChan) {
          contentType = 'youtube_transcript';
          channel = ytChan;
          format = youtubeFormat(r.title || '', ytChan);
        } else if (LI_CONTENT_PREFIXES.some(p => r.slug.startsWith(p))) {
          contentType = 'linkedin_content';
        } else {
          contentType = 'book_summary';
        }
      }

      tagRows.push({ page_id: r.id, tag: `content_type:${contentType}` });
      stats.content_type[contentType] = (stats.content_type[contentType] || 0) + 1;
      if (channel) {
        tagRows.push({ page_id: r.id, tag: `source_channel:${channel}` });
        stats.source_channel[channel] = (stats.source_channel[channel] || 0) + 1;
      }
      if (format) {
        tagRows.push({ page_id: r.id, tag: `format:${format}` });
        stats.format[format] = (stats.format[format] || 0) + 1;
      }
    }

    console.log(`Collected ${tagRows.length} tag rows`);
    console.log('content_type:', stats.content_type);
    console.log('source_channel:', stats.source_channel);
    console.log('format:', stats.format);

    if (apply) {
      const BATCH = 500;
      let written = 0;
      for (let i = 0; i < tagRows.length; i += BATCH) {
        const batch = tagRows.slice(i, i + BATCH);
        await sql`
          INSERT INTO tags ${sql(batch, 'page_id', 'tag')}
          ON CONFLICT (page_id, tag) DO NOTHING
        `;
        written += batch.length;
        if (written % 5000 === 0 || written === tagRows.length) {
          console.log(`  ${written}/${tagRows.length}`);
        }
      }
      const check = await sql`
        SELECT
          count(*) FILTER (WHERE tag LIKE 'content_type:%')::int AS ct,
          count(*) FILTER (WHERE tag LIKE 'source_channel:%')::int AS ch,
          count(*) FILTER (WHERE tag LIKE 'format:%')::int AS fmt
        FROM tags
      `;
      console.log('DB verification:', check[0]);
    }
  } finally {
    await sql.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
