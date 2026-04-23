import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

// Mock the embedding module BEFORE importing runEmbed, so runEmbed picks up
// the mocked embedBatch. We track max concurrent invocations via a counter
// that increments on entry and decrements when the mock resolves.
let activeEmbedCalls = 0;
let maxConcurrentEmbedCalls = 0;
let totalEmbedCalls = 0;

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    activeEmbedCalls++;
    totalEmbedCalls++;
    if (activeEmbedCalls > maxConcurrentEmbedCalls) {
      maxConcurrentEmbedCalls = activeEmbedCalls;
    }
    // Simulate API latency so concurrent workers actually overlap.
    await new Promise(r => setTimeout(r, 30));
    activeEmbedCalls--;
    return texts.map(() => new Float32Array(1536));
  },
}));

// Import AFTER mocking.
const { runEmbed } = await import('../src/commands/embed.ts');

// Proxy-based mock engine that matches test/import-file.test.ts pattern.
function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop]) return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

beforeEach(() => {
  activeEmbedCalls = 0;
  maxConcurrentEmbedCalls = 0;
  totalEmbedCalls = 0;
});

afterEach(() => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
});

describe('runEmbed --all (parallel)', () => {
  test('runs embedBatch calls concurrently across pages', async () => {
    const NUM_PAGES = 20;
    const pages = Array.from({ length: NUM_PAGES }, (_, i) => ({ slug: `page-${i}` }));
    // Each page has one chunk without an embedding (stale).
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text for ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '10';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(NUM_PAGES);
    // Concurrency actually happened.
    expect(maxConcurrentEmbedCalls).toBeGreaterThan(1);
    // And stayed within the configured limit.
    expect(maxConcurrentEmbedCalls).toBeLessThanOrEqual(10);
  });

  test('respects GBRAIN_EMBED_CONCURRENCY=1 (serial)', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => ({ slug: `page-${i}` }));
    const chunksBySlug = new Map(
      pages.map(p => [
        p.slug,
        [{ chunk_index: 0, chunk_text: `text ${p.slug}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 }],
      ]),
    );

    const engine = mockEngine({
      listPages: async () => pages,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '1';

    await runEmbed(engine, ['--all']);

    expect(totalEmbedCalls).toBe(5);
    expect(maxConcurrentEmbedCalls).toBe(1);
  });

  test('skips pages whose chunks are all already embedded when --stale', async () => {
    const pages = [{ slug: 'fresh' }, { slug: 'stale' }];
    const chunksBySlug = new Map<string, any[]>([
      ['fresh', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 }]],
      ['stale', [{ chunk_index: 0, chunk_text: 'hi', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
    ]);

    const engine = mockEngine({
      listPages: async () => pages,
      listSlugsPendingEmbedding: async () => ['stale'],
      getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '5';

    await runEmbed(engine, ['--stale']);

    // Only the stale page triggers an embedBatch call.
    expect(totalEmbedCalls).toBe(1);
  });

  test('fast-path: staleOnly with no stale slugs skips listPages + getChunks entirely', async () => {
    // Regression guard for the autopilot cycle-timeout fix: on a fully-embedded
    // brain, embedAll must NOT iterate all pages via listPages+getChunks. It
    // must early-exit after one listSlugsPendingEmbedding call returning [].
    let listPagesCalls = 0;
    let getChunksCalls = 0;
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => [],
      listPages: async () => { listPagesCalls++; return []; },
      getChunks: async () => { getChunksCalls++; return []; },
      upsertChunks: async () => {},
    });

    await runEmbed(engine, ['--stale']);

    expect(totalEmbedCalls).toBe(0);
    expect(listPagesCalls).toBe(0);
    expect(getChunksCalls).toBe(0);
  });

  test('zero-chunk pages: embedAll staleOnly chunks them on the fly and embeds', async () => {
    // Pages created via direct putPage() (migrate-engine, enrichment-service,
    // output/writer) have no content_chunks rows yet. listSlugsPendingEmbedding
    // surfaces them; embedOnePage must chunk them from page text and embed.
    // Stateful mock: getChunks returns whatever the last upsertChunks stored
    // so the re-read after the chunking upsert sees the new rows.
    const chunkStore = new Map<string, any[]>();
    const upserts: Array<{ slug: string; chunkCount: number }> = [];
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['new-page'],
      getPage: async (slug: string) =>
        slug === 'new-page'
          ? {
              slug: 'new-page',
              compiled_truth: 'Hello world. This is some content for embedding.',
              timeline: '',
            }
          : null,
      getChunks: async (slug: string) => chunkStore.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upserts.push({ slug, chunkCount: inputs.length });
        // Store as Chunk shape: chunk_index + chunk_text + embedded_at (null
        // on first upsert so the subsequent stale-filter still catches them).
        chunkStore.set(slug, inputs.map(i => ({
          chunk_index: i.chunk_index,
          chunk_text: i.chunk_text,
          chunk_source: i.chunk_source,
          embedded_at: null,
          token_count: 5,
        })));
      },
    });

    await runEmbed(engine, ['--stale']);

    // First upsert creates the initial chunks.
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    expect(upserts[0].slug).toBe('new-page');
    expect(upserts[0].chunkCount).toBeGreaterThan(0);
    // Embedding must have run for the new chunks (second upsert writes them back).
    expect(totalEmbedCalls).toBeGreaterThan(0);
  });

  test('zero-chunk pages: one bootstrap failure does not abort the batch', async () => {
    // Regression guard: if getPage or upsertChunks throws for one zero-chunk
    // page, the worker pool must log and continue with the remaining pages,
    // not reject Promise.all and drop everything else on the floor.
    const chunkStore = new Map<string, any[]>();
    const upserts: string[] = [];
    let getPageCalls = 0;
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['bad-page', 'good-page'],
      getPage: async (slug: string) => {
        getPageCalls++;
        if (slug === 'bad-page') throw new Error('simulated DB blip');
        return { slug, compiled_truth: 'Good content for embedding.', timeline: '' };
      },
      getChunks: async (slug: string) => chunkStore.get(slug) ?? [],
      upsertChunks: async (slug: string, inputs: any[]) => {
        upserts.push(slug);
        chunkStore.set(slug, inputs.map(i => ({
          chunk_index: i.chunk_index,
          chunk_text: i.chunk_text,
          chunk_source: i.chunk_source,
          embedded_at: null,
          token_count: 5,
        })));
      },
    });

    // Should NOT throw - the bad page's error is caught per-page.
    await runEmbed(engine, ['--stale']);

    expect(getPageCalls).toBe(2);
    // Good page completed all the way through embed + final upsert.
    // 'bad-page' never upserted (failed at getPage). 'good-page' upserted
    // twice (initial chunk write, then embedding write-back).
    expect(upserts.filter(s => s === 'good-page').length).toBeGreaterThanOrEqual(1);
    expect(upserts.filter(s => s === 'bad-page').length).toBe(0);
    expect(totalEmbedCalls).toBeGreaterThan(0);
  });

  test('zero-chunk pages in dry-run: counts would_embed without any write or API call', async () => {
    const upserts: string[] = [];
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => ['new-page'],
      getPage: async () => ({
        slug: 'new-page',
        compiled_truth: 'short text',
        timeline: '',
      }),
      getChunks: async () => [],
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(upserts).toEqual([]);
    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.would_embed).toBeGreaterThan(0);
  });

  test('fast-path: staleOnly with N stale slugs skips listPages AND getPage (no hydration fan-out)', async () => {
    // Regression guard for the codex-caught bug: the stale-path must iterate
    // slugs directly, NOT hydrate them via Promise.all(staleSlugs.map(getPage)).
    // That fan-out would fire ahead of the GBRAIN_EMBED_CONCURRENCY throttle
    // on a large-stale-brain and reintroduce the pool exhaustion this fix
    // is meant to address.
    const staleSlugs = Array.from({ length: 500 }, (_, i) => `page-${i}`);
    const chunksBySlug = new Map(
      staleSlugs.map(s => [
        s,
        [{ chunk_index: 0, chunk_text: `t ${s}`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }],
      ]),
    );

    let listPagesCalls = 0;
    let getPageCalls = 0;
    const engine = mockEngine({
      listSlugsPendingEmbedding: async () => staleSlugs,
      listPages: async () => { listPagesCalls++; return []; },
      getPage: async () => { getPageCalls++; return null; },
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '10';
    await runEmbed(engine, ['--stale']);

    // embedBatch runs for each stale slug (through the worker pool).
    expect(totalEmbedCalls).toBe(500);
    // But no pre-embed fan-out:
    expect(listPagesCalls).toBe(0);
    expect(getPageCalls).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────
// runEmbedCore dry-run mode (v0.17 regression guard)
// ────────────────────────────────────────────────────────────────

describe('runEmbedCore --dry-run never calls the embedding model', () => {
  test('dry-run --all with stale chunks: no embedBatch calls, accurate would_embed', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const pages = Array.from({ length: 3 }, (_, i) => ({ slug: `page-${i}` }));
    // All 3 pages have 2 stale chunks each (none embedded).
    const chunksBySlug = new Map<string, any[]>(
      pages.map(p => [
        p.slug,
        [
          { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
          { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        ],
      ]),
    );

    const upserts: string[] = [];
    const engine = mockEngine({
      listPages: async () => pages,
      listSlugsPendingEmbedding: async () => pages.map(p => p.slug),
      getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async (slug: string) => { upserts.push(slug); },
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    // No OpenAI calls.
    expect(totalEmbedCalls).toBe(0);
    // No DB writes.
    expect(upserts).toEqual([]);
    // Accurate counts.
    expect(result.dryRun).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.would_embed).toBe(6); // 3 pages * 2 chunks each
    expect(result.skipped).toBe(0);
    expect(result.total_chunks).toBe(6);
    expect(result.pages_processed).toBe(3);
  });

  test('dry-run --stale correctly separates stale from already-embedded', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const pages = [{ slug: 'fresh' }, { slug: 'partial' }, { slug: 'all-stale' }];
    const chunksBySlug = new Map<string, any[]>([
      ['fresh', [
        { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 },
        { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 },
      ]],
      ['partial', [
        { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 },
        { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ]],
      ['all-stale', [
        { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ]],
    ]);

    const engine = mockEngine({
      listPages: async () => pages,
      listSlugsPendingEmbedding: async () => ['partial', 'all-stale'],
      getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true, dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    // Fast path only iterates stale pages, so counts reflect those:
    // 'partial' (2 chunks: 1 stale + 1 skipped) + 'all-stale' (2 stale)
    expect(result.would_embed).toBe(3); // 1 from 'partial' + 2 from 'all-stale'
    expect(result.skipped).toBe(1); // the fresh chunk on 'partial'
    expect(result.total_chunks).toBe(4);
    expect(result.pages_processed).toBe(2);
  });

  test('dry-run --slugs on a single page counts stale chunks, no API calls', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const chunks = [
      { chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      { chunk_index: 1, chunk_text: 'b', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      { chunk_index: 2, chunk_text: 'c', chunk_source: 'compiled_truth', embedded_at: '2026-01-01', token_count: 1 },
    ];

    const engine = mockEngine({
      getPage: async () => ({ slug: 'my-page', compiled_truth: 'text', timeline: '' }),
      getChunks: async () => chunks,
      upsertChunks: async () => {},
    });

    const result = await runEmbedCore(engine, { slugs: ['my-page'], dryRun: true });

    expect(totalEmbedCalls).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.would_embed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.total_chunks).toBe(3);
    expect(result.pages_processed).toBe(1);
  });

  test('non-dry-run path reports accurate embedded count (regression guard)', async () => {
    const { runEmbedCore } = await import('../src/commands/embed.ts');
    const pages = [{ slug: 'a' }, { slug: 'b' }];
    const chunksBySlug = new Map<string, any[]>([
      ['a', [{ chunk_index: 0, chunk_text: 'a', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 }]],
      ['b', [
        { chunk_index: 0, chunk_text: 'x', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
        { chunk_index: 1, chunk_text: 'y', chunk_source: 'compiled_truth', embedded_at: null, token_count: 1 },
      ]],
    ]);

    const engine = mockEngine({
      listPages: async () => pages,
      listSlugsPendingEmbedding: async () => pages.map(p => p.slug),
      getPage: async (slug: string) => pages.find(p => p.slug === slug) ?? null,
      getChunks: async (slug: string) => chunksBySlug.get(slug) || [],
      upsertChunks: async () => {},
    });

    process.env.GBRAIN_EMBED_CONCURRENCY = '2';

    const result = await runEmbedCore(engine, { stale: true });

    expect(result.dryRun).toBe(false);
    expect(result.embedded).toBe(3); // 1 from a + 2 from b
    expect(result.would_embed).toBe(0);
    expect(result.pages_processed).toBe(2);
  });
});
