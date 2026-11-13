#!/usr/bin/env node
// Builds the credits for the open-source software octopus-diff uses, from the workspace's package.json
// files, the installed packages in node_modules and the hand-written `acknowledgements.json` next to
// this file. Writes two outputs:
//
//   apps/web/src/generated/credits.json   shown in the app (Settings → About), with license texts
//   CREDITS.md                            the same list for people reading the repository
//
// `pnpm credits` writes them. `pnpm credits:check` (part of `pnpm lint`) fails if either is out of
// date, so a dependency change without `pnpm credits` keeps `pnpm check` red.
//
// Runtime packages are the `dependencies` of the shipped workspace packages, followed transitively
// (optional and platform-specific dependencies are skipped so the output is the same on every OS).
// Development tools are the direct devDependencies (and dependencies of non-shipped workspace
// packages) that are not already runtime packages.
import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JSON_OUT = path.join(repoRoot, 'apps/web/src/generated/credits.json');
const MD_OUT = path.join(repoRoot, 'CREDITS.md');
const check = process.argv.includes('--check');

const config = JSON.parse(
  await readFile(path.join(repoRoot, 'scripts/credits/acknowledgements.json'), 'utf8'),
);

const SPDX = [
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'BlueOak-1.0.0',
  'MPL-2.0',
  'MIT OR Apache-2.0',
];
/** Canonical SPDX casing (`apache-2.0` → `Apache-2.0`); anything else is kept as published. */
function normalizeLicense(pkg) {
  let license = pkg.license ?? pkg.licenses;
  if (Array.isArray(license)) license = license.map((l) => l.type ?? l).join(' OR ');
  if (license && typeof license === 'object') license = license.type;
  if (typeof license !== 'string' || license === '') return 'UNKNOWN';
  const bare = license.replace(/^\((.*)\)$/, '$1');
  return SPDX.find((id) => id.toLowerCase() === bare.toLowerCase()) ?? license;
}

function personName(person) {
  if (!person) return null;
  if (typeof person === 'string') return person.replace(/\s*[<(].*$/, '').trim() || null;
  return person.name ?? null;
}

function projectUrl(pkg) {
  let repo = pkg.repository;
  if (repo && typeof repo === 'object') repo = repo.url;
  if (typeof repo === 'string') {
    const short = repo.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/);
    if (short) return `https://github.com/${short[1]}`;
    const url = repo
      .replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/\.git$/, '');
    if (url.startsWith('https://')) return url;
  }
  if (typeof pkg.homepage === 'string' && pkg.homepage.startsWith('http')) {
    return pkg.homepage.replace(/#readme$/, '');
  }
  return `https://www.npmjs.com/package/${pkg.name}`;
}

async function readText(dir, pattern) {
  const files = (await readdir(dir)).filter((f) => pattern.test(f)).sort();
  if (files.length === 0) return null;
  const texts = await Promise.all(files.map((f) => readFile(path.join(dir, f), 'utf8')));
  return `${texts.join('\n\n').replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
}

/** Node's lookup: `<dir or an ancestor>/node_modules/<name>`, from the package's real path (pnpm). */
async function resolvePackage(fromDir, name) {
  let dir = await realpath(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpath(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function describe(dir) {
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  return {
    pkg,
    entry: {
      name: pkg.name,
      version: pkg.version,
      license: normalizeLicense(pkg),
      author: personName(pkg.author),
      url: projectUrl(pkg),
      usedBy: [],
      via: null,
      note: config.notes?.[pkg.name] ?? null,
      licenseText: await readText(dir, /^(licen[cs]e|copying)(\.|-|$)/i),
      noticeText: await readText(dir, /^notice(\.|$)/i),
    },
  };
}

// Workspace packages.
const yaml = await readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const block = yaml.match(/^packages:\n((?:[ \t]+-.*\n?)+)/m);
const patterns = block
  ? [...block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
  : [];
const workspaceDirs = [repoRoot];
for (const pattern of patterns) {
  if (pattern.endsWith('/*')) {
    const parent = path.join(repoRoot, pattern.slice(0, -2));
    for (const entry of (await readdir(parent, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isDirectory()) workspaceDirs.push(path.join(parent, entry.name));
    }
  } else {
    workspaceDirs.push(path.join(repoRoot, pattern));
  }
}
const workspaces = [];
for (const dir of workspaceDirs) {
  if (!existsSync(path.join(dir, 'package.json'))) continue;
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  workspaces.push({ dir, pkg, label: dir === repoRoot ? 'root' : path.relative(repoRoot, dir) });
}
const thirdParty = (deps) =>
  Object.entries(deps ?? {})
    .filter(([, spec]) => !String(spec).startsWith('workspace:'))
    .map(([name]) => name)
    .sort();

const problems = [];
const runtime = new Map();
const dev = new Map();

// Runtime: breadth-first from the shipped workspaces' dependencies, sorted, so `via` is stable.
const queue = [];
for (const ws of workspaces) {
  if (!config.shippedWorkspaces.includes(ws.pkg.name)) continue;
  for (const name of thirdParty(ws.pkg.dependencies))
    queue.push({ from: ws.dir, name, ws, via: null });
}
for (const ws of workspaces) {
  for (const name of Object.keys(config.alsoShipped ?? {})) {
    if (thirdParty(ws.pkg.devDependencies).includes(name)) {
      queue.push({ from: ws.dir, name, ws, via: null, note: config.alsoShipped[name] });
    }
  }
}
// A development dependency whose own runtime ships (Electron's binary in the desktop app): credited
// as shipped, without its npm dependencies (they only download that runtime).
for (const ws of workspaces) {
  for (const name of Object.keys(config.shippedRuntimes ?? {})) {
    if (thirdParty(ws.pkg.devDependencies).includes(name)) {
      queue.push({
        from: ws.dir,
        name,
        ws,
        via: null,
        note: config.shippedRuntimes[name],
        leaf: true,
      });
    }
  }
}
while (queue.length > 0) {
  const { from, name, ws, via, note, leaf } = queue.shift();
  const dir = await resolvePackage(from, name);
  if (!dir) {
    problems.push(`not installed: ${name} (run pnpm install)`);
    continue;
  }
  const key = `${name}@${dir}`;
  let item = runtime.get(key);
  if (!item) {
    item = await describe(dir);
    item.entry.via = via;
    runtime.set(key, item);
    for (const dep of leaf ? [] : Object.keys(item.pkg.dependencies ?? {}).sort()) {
      queue.push({ from: dir, name: dep, ws: null, via: name });
    }
  }
  if (ws && !item.entry.usedBy.includes(ws.label)) {
    item.entry.usedBy.push(ws.label);
    item.entry.via = null;
  }
  if (note) item.entry.note = note;
}

// Development tools: direct dependencies that are not runtime packages.
const runtimeNames = new Set([...runtime.values()].map((r) => r.entry.name));
for (const ws of workspaces) {
  const shipped = config.shippedWorkspaces.includes(ws.pkg.name);
  const names = [
    ...thirdParty(ws.pkg.devDependencies),
    ...(shipped ? [] : thirdParty(ws.pkg.dependencies)),
  ];
  for (const name of names) {
    if (runtimeNames.has(name)) continue; // already credited as shipped
    const dir = await resolvePackage(ws.dir, name);
    if (!dir) {
      problems.push(`not installed: ${name} (run pnpm install)`);
      continue;
    }
    let item = dev.get(name);
    if (!item) {
      item = await describe(dir);
      dev.set(name, item);
    }
    if (!item.entry.usedBy.includes(ws.label)) item.entry.usedBy.push(ws.label);
  }
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const runtimeEntries = [...runtime.values()].map((r) => r.entry).sort(byName);
const devEntries = [...dev.values()]
  .map((r) => ({ ...r.entry, via: null, licenseText: null, noticeText: null }))
  .sort(byName);
for (const entry of [...runtimeEntries, ...devEntries]) entry.usedBy.sort();

for (const entry of runtimeEntries) {
  if (!config.allowedRuntimeLicenses.includes(entry.license)) {
    problems.push(
      `license: ${entry.name}@${entry.version} is "${entry.license}", which is not in ` +
        'allowedRuntimeLicenses (scripts/credits/acknowledgements.json). Pick another package, or ' +
        'allow it and log why in docs/DECISIONS.md.',
    );
  }
}

const data = {
  $comment: 'Generated by scripts/credits/generate.mjs (pnpm credits). Do not edit.',
  runtime: runtimeEntries,
  dev: devEntries,
  programs: config.programs,
  adapted: config.adapted,
  inspiration: config.inspiration,
};
const json = `${JSON.stringify(data, null, 2)}\n`;

// CREDITS.md: the same data without the license texts.
const cell = (s) => String(s ?? '').replaceAll('|', '\\|');
const used = (e) => (e.usedBy.length > 0 ? e.usedBy.join(', ') : `via \`${e.via}\``);
const md = [
  '# Credits',
  '',
  '<!-- Generated by scripts/credits/generate.mjs. Do not edit: run `pnpm credits`. -->',
  '',
  'octopus-diff is built on open-source software. This file lists every third-party package it',
  'depends on, the programs it runs, the code adapted from other projects and the projects whose',
  'ideas shaped it. The app shows the same list, with each license text, in **Settings → About**.',
  'octopus-diff itself is MIT licensed (see [LICENSE](LICENSE)).',
  '',
  'This file is generated from the `package.json` files, the installed packages and',
  '[`scripts/credits/acknowledgements.json`](scripts/credits/acknowledgements.json). After any',
  'dependency change run `pnpm credits` and commit the result; `pnpm lint` fails until you do. Code',
  'adapted from another project goes into `acknowledgements.json` (see',
  '[AGENTS.md § Dependencies](AGENTS.md#dependencies)).',
  '',
  '## Shipped with octopus-diff',
  '',
  'Packages that run in the daemon or the CLI, are bundled into the web UI or ship in the desktop',
  'app, including the ones they pull in.',
  '',
  '| Package | Version | License | Used by | Project |',
  '|---|---|---|---|---|',
  ...runtimeEntries.map(
    (e) => `| \`${e.name}\` | ${e.version} | ${cell(e.license)} | ${cell(used(e))} | ${e.url} |`,
  ),
  '',
  ...runtimeEntries.filter((e) => e.note).map((e) => `- \`${e.name}\`: ${e.note}`),
  '',
  '## Development tools',
  '',
  'Used to build, lint and test octopus-diff; not shipped.',
  '',
  '| Package | Version | License | Used by | Project |',
  '|---|---|---|---|---|',
  ...devEntries.map(
    (e) => `| \`${e.name}\` | ${e.version} | ${cell(e.license)} | ${cell(used(e))} | ${e.url} |`,
  ),
  '',
  '## Programs octopus-diff runs',
  '',
  ...config.programs.map((p) => `- **[${p.name}](${p.url})** (${p.license}). ${p.description}`),
  '',
  '## Code adapted from other projects',
  '',
  'Each adapted file also carries an attribution comment.',
  '',
  ...config.adapted.flatMap((a) => [
    `- **[${a.name}](${a.url})**, ${a.license} License, ${a.copyright}`,
    ...a.files.map((f) => `  - \`${f.path}\`: ${f.what}`),
    ...(a.design ? [`  - ${a.design}`] : []),
  ]),
  '',
  '## Inspiration (ideas only, no code)',
  '',
  `${config.inspiration.join(', ')}, which explored multi-repository, worktree and agent-review views`,
  'before us (see `docs/PLAN.md` §3).',
  '',
].join('\n');

if (problems.length > 0) {
  console.error('credits: cannot generate');
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`);
  process.exit(1);
}

const outputs = [
  [JSON_OUT, json],
  [MD_OUT, md],
];
if (check) {
  const stale = [];
  for (const [file, content] of outputs) {
    const current = existsSync(file) ? await readFile(file, 'utf8') : null;
    if (current !== content) stale.push(path.relative(repoRoot, file));
  }
  if (stale.length > 0) {
    console.error(`credits: out of date: ${stale.join(', ')}`);
    console.error(
      'A dependency or scripts/credits/acknowledgements.json changed. Run `pnpm credits`',
    );
    console.error('and commit the result (see AGENTS.md § Dependencies).');
    process.exit(1);
  }
  console.log(
    `credits: up to date (${runtimeEntries.length} shipped packages, ${devEntries.length} dev tools)`,
  );
} else {
  for (const [file, content] of outputs) await writeFile(file, content);
  console.log(
    `credits: wrote ${outputs.map(([f]) => path.relative(repoRoot, f)).join(', ')} ` +
      `(${runtimeEntries.length} shipped packages, ${devEntries.length} dev tools)`,
  );
}
