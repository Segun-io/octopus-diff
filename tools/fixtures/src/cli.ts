#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  DEFAULT_BENCH,
  generateFixtures,
  readManifestFile,
  removeFixtureRoot,
} from './generator.js';
import { generateLargeFixtures, LARGE_LAYOUTS, type LargeLayoutName } from './large.js';
import { findWorktree } from './manifest.js';
import { startAgentSimulator } from './simulator.js';

const USAGE = `octopus-diff-fixtures — scratch repositories for octopus-diff (always under the OS temp dir)

Usage:
  octopus-diff-fixtures generate [--seed N] [--no-acceptance] [--bench] [--repos N] [--worktrees N] [--json]
      Builds fixtures and prints the fixture root and manifest path (or the manifest with --json).
  octopus-diff-fixtures large [--layout large|large-ci] [--json]
      Builds the large monorepo layout (issue #26: ~100k files, stale-index and untracked-heavy
      worktrees; large-ci is the ~20k-file variant) and prints its paths.
  octopus-diff-fixtures simulate --manifest <path> [--worktrees live,live-agent] [--duration S] [--seed N]
      Runs the agent simulator against mutable fixture worktrees.
  octopus-diff-fixtures cleanup <fixture-root>
      Deletes a fixture root (refuses paths outside the OS temp dir).
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }
  if (command === 'generate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        seed: { type: 'string', default: '1' },
        'no-acceptance': { type: 'boolean', default: false },
        bench: { type: 'boolean', default: false },
        repos: { type: 'string' },
        worktrees: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    const bench =
      values.bench || values.repos
        ? {
            repos: Number(values.repos ?? DEFAULT_BENCH.repos),
            worktreesPerRepo: Number(values.worktrees ?? DEFAULT_BENCH.worktreesPerRepo),
          }
        : false;
    const started = Date.now();
    const set = await generateFixtures({
      seed: Number(values.seed),
      acceptance: !values['no-acceptance'],
      bench,
    });
    if (values.json) process.stdout.write(`${JSON.stringify(set.manifest, null, 2)}\n`);
    else {
      const worktrees = set.manifest.projects.reduce((n, p) => n + p.worktrees.length, 0);
      process.stdout.write(
        `fixtures: ${set.manifest.projects.length} repositories, ${worktrees} worktrees in ${Date.now() - started} ms\n` +
          `root:     ${set.root}\nmanifest: ${set.manifestPath}\n` +
          `git env:  GIT_CONFIG_GLOBAL=${set.env.configPath} GIT_CONFIG_NOSYSTEM=1\n` +
          `cleanup:  octopus-diff-fixtures cleanup ${set.root}\n`,
      );
    }
    return 0;
  }
  if (command === 'large') {
    const { values } = parseArgs({
      args: rest,
      options: {
        layout: { type: 'string', default: 'large-ci' },
        json: { type: 'boolean', default: false },
      },
    });
    if (!(values.layout in LARGE_LAYOUTS)) {
      throw new Error(`--layout must be one of ${Object.keys(LARGE_LAYOUTS).join(', ')}`);
    }
    const set = await generateLargeFixtures({ layout: values.layout as LargeLayoutName });
    if (values.json) {
      process.stdout.write(
        `${JSON.stringify({ root: set.root, projectPath: set.projectPath, options: set.options, worktrees: set.worktrees, git: set.env.vars, generationMs: set.generationMs }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `large fixtures (${values.layout}): ${set.options.files} tracked files, ${set.worktrees.length} worktrees in ${set.generationMs} ms\n` +
          `root:     ${set.root}\nproject:  ${set.projectPath}\n` +
          `git env:  GIT_CONFIG_GLOBAL=${set.env.configPath} GIT_CONFIG_NOSYSTEM=1\n` +
          `cleanup:  octopus-diff-fixtures cleanup ${set.root}\n`,
      );
    }
    return 0;
  }
  if (command === 'simulate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        manifest: { type: 'string' },
        worktrees: { type: 'string', default: 'live,live-agent' },
        duration: { type: 'string', default: '30' },
        seed: { type: 'string', default: '1' },
      },
    });
    if (!values.manifest) throw new Error('--manifest is required');
    const manifest = await readManifestFile(values.manifest);
    const env = { configPath: manifest.git.configPath, vars: manifest.git.vars };
    const targets = values.worktrees.split(',').map((name) => {
      const { project, worktree } = findWorktree(manifest, name.trim());
      if (project.role === 'control' || project.role === 'source') {
        throw new Error(
          `${name} belongs to a ${project.role} repository; the simulator only edits mutable/bench ones`,
        );
      }
      return { path: worktree.path, name: worktree.name };
    });
    const sim = startAgentSimulator({
      targets,
      env,
      seed: Number(values.seed),
      durationMs: Number(values.duration) * 1000,
      onAction: (a) =>
        process.stdout.write(
          `${(a.at / 1000).toFixed(1).padStart(6)}s ${a.target} ${a.kind} ${a.oldPath ? `${a.oldPath} → ` : ''}${a.path ?? ''}${a.ok ? '' : ` FAILED ${a.error}`}\n`,
        ),
    });
    process.once('SIGINT', () => void sim.stop());
    const report = await sim.done;
    process.stdout.write(`${report.actions.length} actions, ${report.errors} errors\n`);
    return 0;
  }
  if (command === 'cleanup') {
    const root = rest[0];
    if (!root) throw new Error('cleanup needs the fixture root');
    await removeFixtureRoot(root);
    process.stdout.write(`removed ${root}\n`);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
