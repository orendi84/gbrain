import postgres from 'postgres';
import fs from 'fs';
const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.gbrain/config.json', 'utf8'));
const sql = postgres(cfg.database_url, { max: 1, idle_timeout: 10, connect_timeout: 10 });
try {
  const r = await sql`
    SELECT
      count(DISTINCT page_id) FILTER (WHERE tag LIKE 'domain:%')::int AS d_pages,
      count(DISTINCT page_id) FILTER (WHERE tag LIKE 'theme:%')::int AS t_pages,
      count(DISTINCT page_id) FILTER (WHERE tag LIKE 'audience:%')::int AS a_pages,
      count(*) FILTER (WHERE tag LIKE 'domain:%')::int AS d,
      count(*) FILTER (WHERE tag LIKE 'theme:%')::int AS t,
      count(*) FILTER (WHERE tag LIKE 'audience:%')::int AS a
    FROM tags
  `;
  const remaining = await sql`
    SELECT count(*)::int AS n
    FROM pages p
    WHERE p.type IN ('concept', 'knowledge')
      AND NOT EXISTS (
        SELECT 1 FROM tags t
        WHERE t.page_id = p.id
          AND (t.tag LIKE 'domain:%' OR t.tag LIKE 'theme:%' OR t.tag LIKE 'audience:%')
      )
  `;
  console.log(JSON.stringify({ ...r[0], remaining: remaining[0].n }, null, 2));
} finally { await sql.end(); }
