/**
 * Tree render benchmark (#9, dev only): can `@pierre/trees` hold the 100k-path monorepo layout
 * (tools/fixtures `large`, 8 apps × 10 packages × 10 modules × 5 subdirs × 25 files), and does
 * the lazy design (root listing, then one `GET /tree` listing per expanded directory) meet the
 * explorer's budget (render < 300 ms, scroll p95 < 20 ms)?
 *
 *   pnpm --filter @octopus-diff/web perf:tree          # 5 runs per scenario
 *   TREE_PERF_SMOKE=1 pnpm --filter @octopus-diff/web perf:tree   # 1 run, 20k paths
 *
 * Builds `scripts/tree-perf/` (a page that is never part of the app) with Vite into a temp dir,
 * serves it from this process, drives headless Chromium and prints a JSON summary (ms).
 * `TREE_PERF_OUT=<file>` also writes it there. Every wait is on a real condition (the page's ready
 * flag, frames painted inside the page); no fixed sleeps. Exits 1 when a structural check fails
 * (virtualisation broke: far more rows mounted than fit; a scenario threw).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { build } from 'vite';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}
const smoke = process.env.TREE_PERF_SMOKE === '1';
const COUNT = smoke ? 20_000 : Number(process.env.TREE_PERF_PATHS ?? 100_000);
const RUNS = smoke ? 1 : Number(process.env.TREE_PERF_RUNS ?? 5);
const HERE = path.dirname(fileURLToPath(import.meta.url));

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    n: values.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

async function serve(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const file = path.join(dir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const out = await mkdtemp(path.join(tmpdir(), 'octopus-diff-tree-perf-'));
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  try {
    await build({
      configFile: false,
      root: path.join(HERE, 'tree-perf'),
      base: './',
      logLevel: 'warn',
      build: { outDir: out, emptyOutDir: true, sourcemap: false },
    });
    const server = await serve(out);
    const browser = await chromium.launch();
    const results: Record<string, unknown> = {};
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(() => {
        window.__longTasks = [];
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            window.__longTasks.push({ start: e.startTime, duration: e.duration });
        }).observe({ type: 'longtask', buffered: true });
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const fresh = async () => {
        await page.goto(server.url);
        await page.waitForSelector('body[data-ready="1"]');
      };

      const runFull = async (name: string, options: Record<string, unknown>) => {
        const toPaint: number[] = [];
        const model: number[] = [];
        const render: number[] = [];
        const frames: number[] = [];
        const jumps: number[] = [];
        const longTasks: number[] = [];
        let last: Record<string, unknown> = {};
        for (let r = 0; r < RUNS; r++) {
          await fresh();
          const f = await page.evaluate((o) => window.treeBench.full(o as never), options);
          toPaint.push(f.toPaintMs);
          model.push(f.modelMs + f.prepareMs);
          render.push(f.renderMs);
          const s = await page.evaluate(() => window.treeBench.scroll({ step: 600, steps: 300 }));
          frames.push(...s.frames);
          jumps.push(...s.jumps);
          longTasks.push(...s.longTasks);
          last = {
            visibleRows: f.visibleRows,
            mountedRows: s.mountedRows,
            scrollHeightPx: s.height,
          };
          check(
            `${name}: virtualised (rows mounted after scrolling < 200)`,
            s.mountedRows < 200,
            `${s.mountedRows} rows`,
          );
        }
        results[name] = {
          ...options,
          toPaint: stats(toPaint),
          model: stats(model),
          render: stats(render),
          scrollFrame: stats(frames),
          jump: stats(jumps),
          scrollLongTasks: longTasks.length,
          ...last,
        };
      };

      await runFull('full-closed', { count: COUNT, expansion: 'closed' });
      await runFull('full-open', { count: COUNT, expansion: 'open' });
      await runFull('full-open-prepared', { count: COUNT, expansion: 'open', prepared: true });
      await runFull('full-open-300-statuses', { count: COUNT, expansion: 'open', statuses: 300 });

      // Lazy: root listing, then 200 directory listings opened one by one (breadth first).
      const firstPaint: number[] = [];
      const opens: number[] = [];
      const opensSync: number[] = [];
      const lazyFrames: number[] = [];
      let lazyLast: Record<string, unknown> = {};
      for (let r = 0; r < RUNS; r++) {
        await fresh();
        const l = await page.evaluate(
          (count) => window.treeBench.lazy({ count, opens: 200 }),
          COUNT,
        );
        firstPaint.push(l.firstPaintMs);
        opens.push(...l.opens);
        opensSync.push(...l.opensSync);
        const s = await page.evaluate(() => window.treeBench.scroll({ step: 600, steps: 300 }));
        lazyFrames.push(...s.frames);
        lazyLast = {
          loadedPaths: l.loadedPaths,
          visibleRows: l.visibleRows,
          mountedRows: s.mountedRows,
        };
      }
      results.lazy = {
        count: COUNT,
        firstPaint: stats(firstPaint),
        openDirectory: stats(opens),
        openDirectorySync: stats(opensSync),
        scrollFrame: stats(lazyFrames),
        ...lazyLast,
      };
      check('no page errors', errors.length === 0, errors.join('; ') || 'none');
    } finally {
      await browser.close();
      await server.close();
    }
    const summary = {
      date: new Date().toISOString(),
      paths: COUNT,
      runs: RUNS,
      viewport: '1440x900, tree 480x800',
      results,
      checks,
    };
    const text = `${JSON.stringify(summary, null, 2)}\n`;
    process.stdout.write(text);
    if (process.env.TREE_PERF_OUT) await writeFile(process.env.TREE_PERF_OUT, text);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
