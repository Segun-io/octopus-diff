#!/usr/bin/env node
// Checks that CREDITS.md credits every third-party package the workspace depends on directly.
//
// Fails when a direct dependency (dependencies, devDependencies, optionalDependencies or
// peerDependencies of the root or any workspace package) has no row in a CREDITS.md table, when a row
// names a package that is no longer a dependency, or when a row's license differs from the installed
// package's `license` field. Runs as part of `pnpm lint`.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Workspace package directories from `pnpm-workspace.yaml` (plain dirs and `dir/*` globs only). */
async function workspaceDirs() {
  const yaml = await readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const block = yaml.match(/^packages:\n((?:[ \t]+-.*\n?)+)/m);
  const patterns = block
    ? [...block[1].matchAll(/-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
    : [];
  const dirs = [repoRoot];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = path.join(repoRoot, pattern.slice(0, -2));
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
      }
    } else {
      dirs.push(path.join(repoRoot, pattern));
    }
  }
  return dirs.filter((dir) => existsSync(path.join(dir, 'package.json')));
}

/** name → { license (installed, if found), users: Set of workspace package names } */
async function directDependencies() {
  const deps = new Map();
  for (const dir of await workspaceDirs()) {
    const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (String(spec).startsWith('workspace:')) continue;
        const entry = deps.get(name) ?? { license: undefined, users: new Set() };
        entry.users.add(pkg.name);
        if (entry.license === undefined) {
          const installed = path.join(dir, 'node_modules', name, 'package.json');
          if (existsSync(installed)) {
            entry.license = JSON.parse(await readFile(installed, 'utf8')).license;
          }
        }
        deps.set(name, entry);
      }
    }
  }
  return deps;
}

/** Table rows whose first cell is a backticked package name: name → license column. */
async function creditedPackages() {
  const markdown = await readFile(path.join(repoRoot, 'CREDITS.md'), 'utf8');
  const rows = new Map();
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const name = cells[1]?.match(/^`([^`]+)`$/)?.[1];
    if (name && cells.length >= 5) rows.set(name, cells[3]);
  }
  return rows;
}

const deps = await directDependencies();
const credited = await creditedPackages();
const problems = [];

for (const [name, { license, users }] of deps) {
  const row = credited.get(name);
  const usedBy = [...users].join(', ');
  if (row === undefined) {
    problems.push(`missing: \`${name}\` (${license ?? 'license unknown'}, used by ${usedBy})`);
  } else if (typeof license === 'string' && license.toLowerCase() !== row.toLowerCase()) {
    problems.push(`license: \`${name}\` is "${license}" but CREDITS.md says "${row}"`);
  }
}
for (const name of credited.keys()) {
  if (!deps.has(name))
    problems.push(`stale: \`${name}\` is in CREDITS.md but no longer a dependency`);
}

if (problems.length > 0) {
  console.error('check-credits: CREDITS.md is out of date');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('Add, update or remove the rows in CREDITS.md (see AGENTS.md § Dependencies).');
  process.exit(1);
}
console.log(`check-credits: ${deps.size} direct dependencies credited in CREDITS.md`);
