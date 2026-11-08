import { GitCoreError } from '@octopus-diff/contracts';

/**
 * The only git subcommands git-core may run (PLAN §5.5). Everything else is rejected with
 * `command_not_allowed` before a process is spawned.
 */
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'diff-index',
  'diff-tree',
  'rev-parse',
  'rev-list',
  'merge-base',
  'worktree',
  'for-each-ref',
  'symbolic-ref',
  'show',
  'cat-file',
  'ls-files',
  'log',
  'config',
]);

/** Subcommands that produce diffs and therefore always get `--no-ext-diff --no-textconv`. */
export const DIFF_FAMILY: ReadonlySet<string> = new Set([
  'diff',
  'diff-index',
  'diff-tree',
  'log',
  'show',
]);

/**
 * Options rejected for every subcommand (before `--` / `--end-of-options`). Each either
 * writes files (`--output`), runs programs (`--ext-diff`, `--textconv`, `--filters`,
 * `--show-signature` runs gpg, `--exec`, `--upload-pack`) or re-enables color. Global options
 * (`-c`, `--git-dir`, `-C`, ...) cannot appear at all: the first argument must be the
 * subcommand, and the runner adds its own global options in front of it.
 */
const FORBIDDEN_OPTION_PREFIXES = [
  '--output',
  '--ext-diff',
  '--textconv',
  '--filters',
  '--color',
  '--show-signature',
  '--exec',
  '--upload-pack',
  '--receive-pack',
  '--open-files-in-pager',
] as const;

const WORKTREE_LIST_OPTIONS = new Set(['--porcelain', '-z', '-v', '--verbose']);

const CONFIG_ACTIONS = new Set(['--get', '--get-all', '--get-regexp']);
const CONFIG_OPTIONS = new Set([
  '--null',
  '-z',
  '--local',
  '--global',
  '--system',
  '--worktree',
  '--show-origin',
  '--show-scope',
  '--includes',
  '--no-includes',
  '--bool',
  '--int',
  '--bool-or-int',
  '--path',
  '--type=bool',
  '--type=int',
  '--type=bool-or-int',
  '--type=path',
  '--type=expiry-date',
  '--type=color',
]);

const SYMBOLIC_REF_OPTIONS = new Set(['-q', '--quiet', '--short', '--no-recurse', '--recurse']);

function deny(message: string, args: readonly string[]): never {
  throw new GitCoreError('command_not_allowed', message, { args: [...args] });
}

function isSeparator(arg: string): boolean {
  return arg === '--' || arg === '--end-of-options';
}

/**
 * Throws `command_not_allowed` unless `args` (subcommand first, no global options) is a
 * read-only invocation from the allowlist.
 */
export function assertAllowedGitArgs(args: readonly string[]): void {
  const sub = args[0];
  if (sub === undefined || sub.length === 0) deny('missing git subcommand', args);
  if (sub.startsWith('-')) deny(`global git options are not allowed: ${sub}`, args);
  if (!ALLOWED_SUBCOMMANDS.has(sub)) deny(`git subcommand not allowed: ${sub}`, args);

  for (const arg of args) {
    if (arg.includes('\u0000')) deny('git arguments must not contain NUL', args);
  }

  const rest = args.slice(1);
  for (const arg of rest) {
    if (isSeparator(arg)) break;
    if (!arg.startsWith('-')) continue;
    for (const prefix of FORBIDDEN_OPTION_PREFIXES) {
      if (arg.startsWith(prefix)) deny(`git option not allowed: ${arg}`, args);
    }
  }

  switch (sub) {
    case 'worktree': {
      if (rest[0] !== 'list') deny(`only "git worktree list" is allowed`, args);
      for (const arg of rest.slice(1)) {
        if (!WORKTREE_LIST_OPTIONS.has(arg)) deny(`worktree list option not allowed: ${arg}`, args);
      }
      return;
    }
    case 'config': {
      let actions = 0;
      let positional = 0;
      for (const arg of rest) {
        if (CONFIG_ACTIONS.has(arg)) actions += 1;
        else if (arg.startsWith('-')) {
          if (!CONFIG_OPTIONS.has(arg)) deny(`config option not allowed: ${arg}`, args);
        } else positional += 1;
      }
      if (actions !== 1)
        deny('config requires exactly one of --get, --get-all, --get-regexp', args);
      if (positional < 1 || positional > 2)
        deny('config --get takes a key and an optional pattern', args);
      return;
    }
    case 'symbolic-ref': {
      let positional = 0;
      for (const arg of rest) {
        if (arg.startsWith('-')) {
          if (!SYMBOLIC_REF_OPTIONS.has(arg)) deny(`symbolic-ref option not allowed: ${arg}`, args);
        } else positional += 1;
      }
      if (positional !== 1) deny('symbolic-ref may only read a single ref', args);
      return;
    }
    default:
      return;
  }
}
