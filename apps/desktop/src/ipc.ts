/**
 * The main-process side of `window.octopusDesktop` (docs/DESKTOP.md §3.4, §5). Pure: `main.ts`
 * registers these handlers with `ipcMain` and injects Electron's shell, dialog, clipboard and badge
 * calls, so the tests cover every rule without the binary.
 *
 * Every handler, before anything else:
 * 1. checks the sender (`senderAllowed`): our window's main frame, on the UI's origin (the daemon's,
 *    or Vite's in UI dev mode); nothing while one of our own screens is showing;
 * 2. validates its arguments with zod (exact arity, no extra keys).
 * Paths go through the path check (`path-guard.ts`); `openPath` refuses what would run a program
 * (`open-safety.ts`); editor URLs are built here and must pass the allowlist (`editor-url.ts`).
 * Refusals are values, never throws, and are logged with the reason only (no path, no URL).
 *
 * Read-only: nothing here runs git or writes to a repository.
 */
import {
  AbsolutePathSchema,
  DESKTOP_EDITORS,
  type DesktopActionResult,
  IdSchema,
  RepoPathSchema,
} from '@octopus-diff/contracts';
import { z } from 'zod';
import { editorUrl, isAllowedEditorUrl } from './editor-url.js';
import { BRIDGE_CHANNELS } from './ipc-channels.js';
import { openPathRefusal } from './open-safety.js';
import {
  type Refusal,
  refuse,
  resolveWorktreeTarget,
  type TargetFs,
  type WorktreeRecord,
} from './path-guard.js';
import { httpOrigin } from './policy.js';

export { BRIDGE_CHANNELS, COMMAND_CHANNEL } from './ipc-channels.js';

/** The parts of an `IpcMainInvokeEvent` / `IpcMainEvent` the checks read. */
export interface IpcEventLike {
  sender: { id: number };
  /** Null when the frame navigated away or was destroyed before the message was handled. */
  senderFrame: { url: string; parent: unknown } | null;
}

export interface TrustedSender {
  /** Our window's `webContents.id` (null: no window). */
  webContentsId: number | null;
  /** The UI's origin while the UI is showing (null on our screens, before the UI). */
  origin: string | null;
}

export function senderAllowed(event: IpcEventLike, trusted: TrustedSender): boolean {
  if (trusted.webContentsId === null || trusted.origin === null) return false;
  if (event.sender.id !== trusted.webContentsId) return false;
  const frame = event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  const origin = httpOrigin(frame.url);
  return origin !== null && origin === trusted.origin;
}

export interface BridgeDeps {
  platform: NodeJS.Platform;
  trusted(): TrustedSender;
  /** The daemon's worktrees (`GET /api/projects`); null when the daemon is not ready. */
  listWorktrees(): Promise<WorktreeRecord[] | null>;
  fs: TargetFs;
  showItemInFolder(fullPath: string): void;
  /** `shell.openPath`: '' on success, else an error message. */
  openPath(fullPath: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  pickFolder(options: { title?: string; defaultPath?: string }): Promise<string | null>;
  setBadge(count: number): void;
  writeClipboard(text: string): void;
  commandsReady(webContentsId: number): void;
  log(line: string): void;
}

const MAX_CLIPBOARD = 32 * 1024 * 1024;

/**
 * A path the folder dialog may start in without reaching the network: on Windows a drive path
 * (`C:\` or `C:/`), never `//host/share`, `\\host\share` or a `\\?\` device path (Windows
 * would connect over SMB and send the user's NTLM hash); elsewhere a single leading `/`.
 */
export function isLocalAbsolutePath(p: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p);
  return p.startsWith('/') && !p.startsWith('//');
}

/** A local absolute path to an existing directory (`stat` only after the path check). */
async function isLocalDirectory(
  p: string,
  deps: Pick<BridgeDeps, 'platform' | 'fs'>,
): Promise<boolean> {
  if (!isLocalAbsolutePath(p, deps.platform)) return false;
  try {
    return (await deps.fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

const TargetArgs = z.tuple([IdSchema, RepoPathSchema.optional()]);
const EditorArgs = z.tuple([
  IdSchema,
  RepoPathSchema.optional(),
  z
    .strictObject({
      editor: z.enum(DESKTOP_EDITORS).optional(),
      line: z.number().int().min(1).max(10_000_000).optional(),
    })
    .optional(),
]);
const PickFolderArgs = z.tuple([
  z
    .strictObject({
      title: z.string().max(200).optional(),
      defaultPath: AbsolutePathSchema.optional(),
    })
    .optional(),
]);
const BadgeArgs = z.tuple([z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)]);
const CopyArgs = z.tuple([z.string().max(MAX_CLIPBOARD)]);
const NoArgs = z.tuple([]);

export type InvokeHandler = (event: IpcEventLike, ...args: unknown[]) => Promise<unknown>;
type OnHandler = (event: IpcEventLike, ...args: unknown[]) => void;

export interface BridgeHandlers {
  /** `ipcMain.handle(channel, handler)`. */
  invoke: Record<string, InvokeHandler>;
  /** `ipcMain.on(channel, handler)`. */
  on: Record<string, OnHandler>;
}

const OK: DesktopActionResult = { ok: true };

export interface Guard {
  /** Logs a refusal (`bridge: <method> refused (<reason>)`, never a path) and returns it. */
  note(method: string, refusal: Refusal): Refusal;
  forbidden(method: string): Refusal;
  invalid(method: string): Refusal;
  /**
   * An `ipcMain.handle` handler: the sender check, then zod on the exact argument tuple, then
   * `run`; `fallback` turns a refusal into the method's return value (nothing throws to the page).
   */
  handler<T extends z.ZodType, R>(
    method: string,
    schema: T,
    fallback: (refusal: Refusal) => R,
    run: (args: z.infer<T>) => Promise<R>,
  ): InvokeHandler;
}

/**
 * The checks every bridge channel goes through, shared with the command installer's channels
 * (`cli-shim-ipc.ts`, #547), so no channel has a weaker sender check.
 */
export function createGuard(deps: Pick<BridgeDeps, 'trusted' | 'log'>): Guard {
  const note = (method: string, refusal: Refusal): Refusal => {
    deps.log(`bridge: ${method} refused (${refusal.reason})`);
    return refusal;
  };
  const forbidden = (method: string) =>
    note(method, refuse('forbidden', 'Not available from this page.'));
  const invalid = (method: string) => note(method, refuse('invalid', 'Invalid arguments.'));
  return {
    note,
    forbidden,
    invalid,
    handler(method, schema, fallback, run) {
      return async (event, ...raw) => {
        if (!senderAllowed(event, deps.trusted())) return fallback(forbidden(method));
        const parsed = schema.safeParse(raw);
        if (!parsed.success) return fallback(invalid(method));
        return run(parsed.data);
      };
    },
  };
}

export function createBridgeHandlers(deps: BridgeDeps): BridgeHandlers {
  const { note, forbidden, invalid, handler } = createGuard(deps);

  const asResult = (r: Refusal): DesktopActionResult => r;

  async function target(method: string, worktreeId: string, relPath: string | undefined) {
    const worktrees = await deps.listWorktrees().catch(() => null);
    const result = await resolveWorktreeTarget({
      worktreeId,
      relPath,
      worktrees,
      platform: deps.platform,
      fs: deps.fs,
    });
    return result.ok ? result : note(method, result);
  }

  const failed = (method: string, message: string) => note(method, refuse('failed', message));

  return {
    invoke: {
      [BRIDGE_CHANNELS.pickFolder]: handler(
        'pickFolder',
        PickFolderArgs,
        () => null,
        async ([options]) => {
          const { defaultPath, ...rest } = options ?? {};
          // A hint only: dropped unless it is a local absolute directory (checked in that order,
          // so a UNC path is never touched, #548).
          const start =
            defaultPath !== undefined && (await isLocalDirectory(defaultPath, deps))
              ? { defaultPath }
              : {};
          try {
            return await deps.pickFolder({ ...rest, ...start });
          } catch {
            deps.log('bridge: pickFolder failed');
            return null;
          }
        },
      ),
      [BRIDGE_CHANNELS.revealPath]: handler(
        'revealPath',
        TargetArgs,
        asResult,
        async ([worktreeId, relPath]) => {
          const t = await target('revealPath', worktreeId, relPath);
          if (!t.ok) return t;
          deps.showItemInFolder(t.path);
          return OK;
        },
      ),
      [BRIDGE_CHANNELS.openPath]: handler(
        'openPath',
        TargetArgs,
        asResult,
        async ([worktreeId, relPath]) => {
          const t = await target('openPath', worktreeId, relPath);
          if (!t.ok) return t;
          const unsafe = openPathRefusal(t, deps.platform);
          if (unsafe) return note('openPath', unsafe);
          const error = await deps.openPath(t.path).catch((e: unknown) => String(e));
          return error === '' ? OK : failed('openPath', 'No app could open it.');
        },
      ),
      [BRIDGE_CHANNELS.openInEditor]: handler(
        'openInEditor',
        EditorArgs,
        asResult,
        async ([worktreeId, relPath, options]) => {
          const t = await target('openInEditor', worktreeId, relPath);
          if (!t.ok) return t;
          const editor = options?.editor ?? 'vscode';
          const url = editorUrl(editor, t.path, options?.line, deps.platform);
          if (url === null || !isAllowedEditorUrl(url)) {
            return failed('openInEditor', 'This path cannot be opened in an editor.');
          }
          try {
            await deps.openExternal(url);
            return OK;
          } catch {
            return failed('openInEditor', 'The editor did not open. Is it installed?');
          }
        },
      ),
      [BRIDGE_CHANNELS.setBadge]: handler('setBadge', BadgeArgs, asResult, async ([count]) => {
        deps.setBadge(count);
        return OK;
      }),
      [BRIDGE_CHANNELS.copyText]: handler(
        'copyText',
        CopyArgs,
        () => false,
        async ([text]) => {
          try {
            deps.writeClipboard(text);
            return true;
          } catch {
            deps.log('bridge: copyText failed');
            return false;
          }
        },
      ),
    },
    on: {
      [BRIDGE_CHANNELS.commandsReady]: (event, ...raw) => {
        if (!senderAllowed(event, deps.trusted())) {
          forbidden('commandsReady');
          return;
        }
        if (!NoArgs.safeParse(raw).success) {
          invalid('commandsReady');
          return;
        }
        deps.commandsReady(event.sender.id);
      },
    },
  };
}
