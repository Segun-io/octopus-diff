/**
 * Generates the favicons, app icons and the design contact sheet from `public/favicon.svg`
 * (docs/design/IDENTITY.md). Deterministic: headless Chromium at device scale 1, fixed sizes.
 *
 *   pnpm --filter @octopus-diff/web icons
 *
 * Outputs (committed): public/favicon.ico (16/32/48), public/apple-touch-icon.png (180),
 * public/icon-192.png, public/icon-512.png, public/icon-maskable-192.png,
 * public/icon-maskable-512.png, and docs/design/assets/contact-sheet.png.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

const LIBS = path.join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
if (existsSync(LIBS)) {
  process.env.LD_LIBRARY_PATH = [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
}

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const publicDir = path.join(webRoot, 'public');
const designAssets = path.join(webRoot, '../../docs/design/assets');

/** Brand colours (keep in sync with src/theme/themes/octopus-{dark,light}.ts). */
const INK = '#0b0d14';
const VIOLET_DARK = '#9d90ff';
const VIOLET_LIGHT = '#5b47d6';
const PAPER = '#f4f5f9';

function markSvg(fill: string, size: number): string {
  // The favicon's own <style> picks the colour from prefers-color-scheme; for raster output we
  // want a fixed colour, so the class rule is replaced.
  // Colours are inlined (several marks of different colours share one document in the sheet).
  return svgSource
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replace('class="m"', `fill="${fill}" stroke="${fill}"`)
    .replace('<svg ', `<svg width="${size}" height="${size}" `);
}

let svgSource = '';

async function shot(page: Page, html: string, size: number, transparent: boolean): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;${transparent ? 'background:transparent' : ''}">${html}</body></html>`,
  );
  return page.screenshot({
    type: 'png',
    omitBackground: transparent,
    clip: { x: 0, y: 0, width: size, height: size },
  });
}

/** Mark on a solid square, `scale` = fraction of the canvas the mark occupies. */
function tile(size: number, bg: string, fill: string, scale: number): string {
  const mark = Math.round(size * scale);
  const offset = Math.round((size - mark) / 2);
  return `<div style="width:${size}px;height:${size}px;background:${bg};position:relative">
    <div style="position:absolute;left:${offset}px;top:${offset}px;width:${mark}px;height:${mark}px">${markSvg(fill, mark)}</div>
  </div>`;
}

/** ICO container with PNG-compressed images (supported by every current browser and Windows). */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  const blobs: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...blobs]);
}

async function main() {
  svgSource = await readFile(path.join(publicDir, 'favicon.svg'), 'utf8');
  await mkdir(designAssets, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });

  // favicon.ico: transparent, dark-scheme violet (tab strips are mostly dark; the SVG favicon
  // is adaptive and preferred by browsers that support it).
  const icoSizes = [16, 32, 48];
  const icoImages = [];
  for (const size of icoSizes) {
    icoImages.push({ size, png: await shot(page, markSvg(VIOLET_DARK, size), size, true) });
  }
  await writeFile(path.join(publicDir, 'favicon.ico'), buildIco(icoImages));

  // App icons: solid ink background, violet mark.
  const any = (size: number) => shot(page, tile(size, INK, VIOLET_DARK, 0.62), size, false);
  const maskable = (size: number) => shot(page, tile(size, INK, VIOLET_DARK, 0.5), size, false);
  await writeFile(path.join(publicDir, 'apple-touch-icon.png'), await any(180));
  await writeFile(path.join(publicDir, 'icon-192.png'), await any(192));
  await writeFile(path.join(publicDir, 'icon-512.png'), await any(512));
  await writeFile(path.join(publicDir, 'icon-maskable-192.png'), await maskable(192));
  await writeFile(path.join(publicDir, 'icon-maskable-512.png'), await maskable(512));

  // Contact sheet: 16/32/64/512 on light and dark, plus the app icon tiles.
  const sizes = [16, 32, 64, 512];
  const row = (bg: string, fill: string, label: string) =>
    `<div style="display:flex;align-items:flex-end;gap:24px;padding:24px;background:${bg};color:${fill};font:12px ui-monospace,monospace">
      ${sizes.map((s) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px">${markSvg(fill, s)}<span>${s}</span></div>`).join('')}
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px">${tile(96, INK, VIOLET_DARK, 0.62)}<span>icon</span></div>
      <div style="display:flex;flex-direction:column;align-items:center;gap:8px"><div style="border-radius:50%;overflow:hidden">${tile(96, INK, VIOLET_DARK, 0.5)}</div><span>maskable</span></div>
      <span style="align-self:flex-start;margin-left:auto">${label}</span>
    </div>`;
  const sheet = `${row(PAPER, VIOLET_LIGHT, 'octopus-light #5b47d6')}${row(INK, VIOLET_DARK, 'octopus-dark #9d90ff')}`;
  await page.setViewportSize({ width: 1100, height: 1200 });
  await page.setContent(`<!doctype html><html><body style="margin:0">${sheet}</body></html>`);
  const body = page.locator('body');
  await body.screenshot({ path: path.join(designAssets, 'contact-sheet.png'), type: 'png' });

  await browser.close();
  console.log('icons written to', publicDir, 'and', designAssets);
}

await main();
