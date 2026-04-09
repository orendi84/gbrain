import { readdirSync, statSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { importFile } from '../core/import-file.ts';

export async function runImport(engine: BrainEngine, args: string[]) {
  const dir = args.find(a => !a.startsWith('--'));
  const noEmbed = args.includes('--no-embed');

  if (!dir) {
    console.error('Usage: gbrain import <dir> [--no-embed]');
    process.exit(1);
  }

  // Collect all .md files
  const files = collectMarkdownFiles(dir);
  console.log(`Found ${files.length} markdown files`);

  let imported = 0;
  let skipped = 0;
  let errors = 0;
  let chunksCreated = 0;
  const importedSlugs: string[] = [];
  const errorCounts: Record<string, number> = {};
  const startTime = Date.now();

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    const relativePath = relative(dir, filePath);

    // Structured progress (every 100 files or every 5 seconds worth)
    if ((i + 1) % 100 === 0 || i === files.length - 1) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = elapsed > 0 ? Math.round((i + 1) / elapsed) : 0;
      const remaining = rate > 0 ? Math.round((files.length - i - 1) / rate) : 0;
      const pct = Math.round(((i + 1) / files.length) * 100);
      console.log(`[gbrain import] ${i + 1}/${files.length} (${pct}%) | ${rate} files/sec | imported: ${imported} | skipped: ${skipped} | errors: ${errors} | ETA: ${remaining}s`);
    }

    try {
      const result = await importFile(engine, filePath, relativePath, { noEmbed });
      if (result.status === 'imported') {
        imported++;
        chunksCreated += result.chunks;
        importedSlugs.push(result.slug);
      } else {
        skipped++;
        if (result.error && result.error !== 'unchanged') {
          console.error(`  Skipped ${relativePath}: ${result.error}`);
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Track error patterns — suppress after 5 of the same type
      const errorKey = msg.replace(/"[^"]*"/g, '""');
      errorCounts[errorKey] = (errorCounts[errorKey] || 0) + 1;
      if (errorCounts[errorKey] <= 5) {
        console.error(`  Warning: skipped ${relativePath}: ${msg}`);
      } else if (errorCounts[errorKey] === 6) {
        console.error(`  (suppressing further "${errorKey.slice(0, 60)}..." errors)`);
      }
      errors++;
      skipped++;
    }
  }

  // Error summary
  for (const [err, count] of Object.entries(errorCounts)) {
    if (count > 5) {
      console.error(`  ${count} files failed: ${err.slice(0, 100)}`);
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nImport complete (${totalTime}s):`);
  console.log(`  ${imported} pages imported`);
  console.log(`  ${skipped} pages skipped (${skipped - errors} unchanged, ${errors} errors)`);
  console.log(`  ${chunksCreated} chunks created`);

  // Log the ingest
  await engine.logIngest({
    source_type: 'directory',
    source_ref: dir,
    pages_updated: importedSlugs,
    summary: `Imported ${imported} pages, ${skipped} skipped, ${chunksCreated} chunks`,
  });

  // Import → sync continuity: write sync checkpoint if this is a git repo
  try {
    if (existsSync(join(dir, '.git'))) {
      const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
      await engine.setConfig('sync.last_commit', head);
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await engine.setConfig('sync.repo_path', dir);
    }
  } catch {
    // Not a git repo or git not available, skip checkpoint
  }
}

function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(d: string) {
    for (const entry of readdirSync(d)) {
      // Skip hidden dirs and .raw dirs
      if (entry.startsWith('.')) continue;

      const full = join(d, entry);
      const stat = statSync(full);

      if (stat.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.md')) {
        files.push(full);
      }
    }
  }

  walk(dir);
  return files.sort();
}
