/**
 * The `octopus-diff` command installer's flow (docs/DESKTOP.md §3.2, roadmap #21): inspect what is
 * there, decide (`cli-shim.ts`), write, and say what happened. The filesystem, the PATH and the
 * Windows user-PATH registry value are injected (`cli-shim-fs.ts` has the real ones), so every
 * branch is unit-tested. No git, no repository access.
 */
import type {
  DesktopCliConflict,
  DesktopCliInstallResult,
  DesktopCliOutcome,
  DesktopCliStatus,
} from '@octopus-diff/contracts';
import {
  addToUserPathValue,
  CliShimError,
  COMMAND_NAME,
  type Decision,
  decide,
  type FileFacts,
  type LauncherLocation,
  launcherLocation,
  pathCandidates,
  pathContainsDir,
  renderLauncher,
  resolveTarget,
} from './cli-shim.js';

/** Thrown by `ShimFs.create` when something is already at the path (it never replaces it). */
export class ShimExistsError extends Error {
  override readonly name = 'ShimExistsError';
  constructor(readonly file: string) {
    super(`${file} already exists`);
  }
}

/** Thrown by `ShimFs.replaceOwn` when the file no longer carries the marker. */
export class ShimNotOursError extends Error {
  override readonly name = 'ShimNotOursError';
  constructor(readonly file: string) {
    super(`${file} is not an octopus-diff launcher`);
  }
}

export interface ShimFs {
  /** What is at `file`, without following a symlink; the top of a regular file's text. */
  inspect(file: string): FileFacts;
  mkdirp(dir: string): void;
  /** Creates `file` only if nothing is there (exclusive); else throws `ShimExistsError`. */
  create(file: string, content: string): void;
  /** Replaces `file` only while it still carries the marker; else throws `ShimNotOursError`. */
  replaceOwn(file: string, content: string): void;
}

export type RegistryKind = 'String' | 'ExpandString';

/** The user's PATH value in the registry (Windows only; no admin rights needed). */
export interface UserPathEditor {
  /** The raw value (`%VAR%` unexpanded) and its registry type; `value` is null when unset. */
  read(): Promise<{ value: string | null; kind: RegistryKind }>;
  write(value: string, kind: RegistryKind): Promise<void>;
}

export interface CliShimDeps {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  /** `process.execPath`: the app binary. */
  execPath: string;
  /** The bundled CLI entry. */
  entry: string;
  isPackaged: boolean;
  fs: ShimFs;
  /**
   * The PATH a terminal has: the login shell's on macOS/Linux (a GUI launch has a minimal one),
   * the process PATH on Windows. Used for "is the directory on PATH" and "is another install there".
   */
  pathValue(): Promise<string> | string;
  /** Windows only. */
  userPath?: UserPathEditor;
  log?(note: string): void;
}

export interface CliShim {
  status(): Promise<DesktopCliStatus>;
  install(): Promise<DesktopCliInstallResult>;
  /**
   * At startup: rewrite our own outdated launcher (the app moved or was updated). Never creates one
   * (installing is the user's choice), never touches anything else, never throws.
   */
  refresh(): Promise<'updated' | 'skipped'>;
}

type Assessment =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'ready';
      location: LauncherLocation;
      desired: string;
      decision: Decision;
      onPath: boolean;
    };

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createCliShim(deps: CliShimDeps): CliShim {
  const win = deps.platform === 'win32';
  const note = (text: string) => deps.log?.(text);

  async function onPathOf(location: LauncherLocation, pathValue: string): Promise<boolean> {
    if (pathContainsDir(pathValue, location.dir, deps.platform, deps.env)) return true;
    if (!win || !deps.userPath) return false;
    try {
      const { value } = await deps.userPath.read();
      return value !== null && pathContainsDir(value, location.dir, 'win32', deps.env);
    } catch {
      return false;
    }
  }

  async function assess(): Promise<Assessment> {
    const resolved = resolveTarget({
      platform: deps.platform,
      env: deps.env,
      execPath: deps.execPath,
      entry: deps.entry,
      isPackaged: deps.isPackaged,
    });
    if (!resolved.ok) return { kind: 'unavailable', reason: resolved.reason };
    let desired: string;
    try {
      desired = renderLauncher(resolved.target);
    } catch (error) {
      if (error instanceof CliShimError) {
        return {
          kind: 'unavailable',
          reason: `This app's location cannot be used by a launcher: ${error.message}.`,
        };
      }
      throw error;
    }
    const location = launcherLocation({
      platform: deps.platform,
      env: deps.env,
      homedir: deps.homedir,
    });
    const pathValue = await deps.pathValue();
    const others = pathCandidates({
      platform: deps.platform,
      env: deps.env,
      pathValue,
      target: location.file,
    })
      .map((file) => ({ path: file, facts: deps.fs.inspect(file) }))
      .filter((o) => o.facts.kind !== 'missing');
    const target = deps.fs.inspect(location.file);
    const decision = decide({ desired, targetPath: location.file, target, others });
    return {
      kind: 'ready',
      location,
      desired,
      decision,
      onPath: await onPathOf(location, pathValue),
    };
  }

  function statusOf(a: Assessment): DesktopCliStatus {
    if (a.kind === 'unavailable') return { state: 'unavailable', reason: a.reason };
    const base = { path: a.location.file, onPath: a.onPath };
    switch (a.decision.action) {
      case 'install':
        return { state: 'not-installed', ...base };
      case 'update':
        return { state: 'outdated', ...base };
      case 'current':
        return { state: 'current', ...base };
      case 'refuse':
        return { state: 'conflict', ...base, conflict: a.decision.conflict };
    }
  }

  const result = async (
    outcome: DesktopCliOutcome,
    message: string,
  ): Promise<DesktopCliInstallResult> => ({
    outcome,
    status: statusOf(await assess()),
    message,
  });

  function refusal(conflict: DesktopCliConflict): string {
    return conflict.kind === 'at-target'
      ? `${conflict.path} already exists and was not written by octopus-diff, so it was left alone. ` +
          'Move or delete it if you want the app to install its command there.'
      : `An ${COMMAND_NAME} command is already installed at ${conflict.path} (for example from npm), ` +
          'so nothing was changed. It runs the same CLI; remove it first if you would rather use the app’s.';
  }

  /** Windows: put the launcher's directory on the user's PATH. Returns the sentence to add, or ''. */
  async function ensureUserPath(location: LauncherLocation): Promise<string> {
    if (!win || !deps.userPath) return '';
    try {
      const { value, kind } = await deps.userPath.read();
      const next = addToUserPathValue(value, location.dir, deps.env);
      if (!next.changed) return '';
      await deps.userPath.write(next.value, kind);
      note(`added ${location.dir} to the user PATH`);
      return ` Added ${location.dir} to your user PATH; open a new terminal to use it.`;
    } catch (error) {
      note(`could not add ${location.dir} to the user PATH: ${errorText(error)}`);
      return (
        ` Could not add ${location.dir} to your PATH (${errorText(error)}). ` +
        'Add it in Settings → Environment Variables to use the command.'
      );
    }
  }

  function pathHint(location: LauncherLocation, onPath: boolean): string {
    if (onPath || win) return '';
    const home = deps.homedir;
    const profile =
      location.dir === `${home}/.local/bin`
        ? 'export PATH="$HOME/.local/bin:$PATH"'
        : `export PATH="${location.dir}:$PATH"`;
    return (
      ` ${location.dir} is not on your PATH. Add it to your shell profile ` +
      `(${profile}), then open a new terminal.`
    );
  }

  /** Writes per the decision. Returns the outcome, or the refusal when a race lost to a real file. */
  async function write(
    a: Extract<Assessment, { kind: 'ready' }>,
  ): Promise<{ outcome: DesktopCliOutcome; conflict?: DesktopCliConflict }> {
    const { location, desired, decision } = a;
    if (decision.action === 'current') return { outcome: 'unchanged' };
    try {
      if (decision.action === 'install') {
        deps.fs.mkdirp(location.dir);
        deps.fs.create(location.file, desired);
        note(`installed the ${COMMAND_NAME} command at ${location.file}`);
        return { outcome: 'installed' };
      }
      deps.fs.replaceOwn(location.file, desired);
      note(`updated the ${COMMAND_NAME} command at ${location.file}`);
      return { outcome: 'updated' };
    } catch (error) {
      if (error instanceof ShimExistsError || error instanceof ShimNotOursError) {
        // Something that is not ours took the place between the check and the write: leave it.
        return { outcome: 'refused', conflict: { kind: 'at-target', path: location.file } };
      }
      throw error;
    }
  }

  return {
    async status() {
      return statusOf(await assess());
    },

    async install() {
      const a = await assess();
      if (a.kind === 'unavailable') return result('unavailable', a.reason);
      if (a.decision.action === 'refuse') {
        return result('refused', refusal(a.decision.conflict));
      }
      let outcome: DesktopCliOutcome;
      try {
        const written = await write(a);
        if (written.outcome === 'refused' && written.conflict) {
          return result('refused', refusal(written.conflict));
        }
        outcome = written.outcome;
      } catch (error) {
        note(`could not write ${a.location.file}: ${errorText(error)}`);
        return result('failed', `Could not write ${a.location.file}: ${errorText(error)}`);
      }
      const added = await ensureUserPath(a.location);
      const after = await assess();
      const onPath = after.kind === 'ready' ? after.onPath : a.onPath;
      const lead =
        outcome === 'installed'
          ? `Installed the ${COMMAND_NAME} command at ${a.location.file}.`
          : outcome === 'updated'
            ? `Updated the ${COMMAND_NAME} command at ${a.location.file} to point at this app.`
            : `The ${COMMAND_NAME} command at ${a.location.file} already points at this app.`;
      return {
        outcome,
        status: statusOf(after),
        message: `${lead}${added}${pathHint(a.location, onPath)}`,
      };
    },

    async refresh() {
      try {
        const a = await assess();
        if (a.kind !== 'ready' || a.decision.action !== 'update') return 'skipped';
        const written = await write(a);
        return written.outcome === 'updated' ? 'updated' : 'skipped';
      } catch (error) {
        note(`could not refresh the ${COMMAND_NAME} command: ${errorText(error)}`);
        return 'skipped';
      }
    },
  };
}
