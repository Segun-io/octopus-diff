/**
 * Auth v2 token bootstrap (see `packages/contracts/src/common.ts`). The CLI prints
 * `<url>/#token=<token>`; on load the token moves from the fragment into
 * `localStorage[TOKEN_STORAGE_KEY]` (origin-scoped, port included) and the fragment is removed
 * from the address bar. The API client sends it as `Authorization: Bearer`. No cookies.
 */
import { AUTH_FRAGMENT_PARAM, TOKEN_STORAGE_KEY } from '@octopus-diff/contracts';

/** Same alphabet and length as the daemon's tokens; anything else is ignored. */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

export interface TokenWindow {
  location: Pick<Location, 'hash' | 'pathname' | 'search' | 'reload'>;
  history: Pick<History, 'replaceState' | 'state'>;
  localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  addEventListener?: (type: 'hashchange', listener: () => void) => void;
}

/** Set only when localStorage could not keep the token (blocked or full): this tab only. */
let memoryToken: string | null = null;

function storageOf(win: TokenWindow): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return win.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored token, or null when this browser has none. */
export function readToken(win: TokenWindow | undefined = browserWindow()): string | null {
  if (!win) return memoryToken;
  try {
    const stored = storageOf(win)?.getItem(TOKEN_STORAGE_KEY) ?? null;
    if (stored !== null && TOKEN_PATTERN.test(stored)) return stored;
  } catch {
    // Storage access denied: fall back to memory.
  }
  return memoryToken;
}

function storeToken(win: TokenWindow, token: string): void {
  const storage = storageOf(win);
  try {
    if (!storage) throw new Error('no localStorage');
    storage.setItem(TOKEN_STORAGE_KEY, token);
    memoryToken = null;
  } catch {
    // Storage missing, full or denied: the memory copy still works in this tab.
    memoryToken = token;
  }
}

export interface FragmentResult {
  /** True when the address bar had a `#token=` (it has been removed). */
  found: boolean;
  /** True when a valid token was found and it differs from the one stored before. */
  changed: boolean;
}

/**
 * Moves `#token=` from `location.hash` into storage and strips it with `history.replaceState`
 * (other fragment parameters are kept). Invalid values are stripped but not stored.
 */
export function takeTokenFromFragment(win: TokenWindow): FragmentResult {
  const hash = win.location.hash.replace(/^#/, '');
  if (hash === '') return { found: false, changed: false };
  const params = new URLSearchParams(hash);
  const token = params.get(AUTH_FRAGMENT_PARAM);
  if (token === null) return { found: false, changed: false };
  params.delete(AUTH_FRAGMENT_PARAM);
  const rest = params.toString();
  win.history.replaceState(
    win.history.state,
    '',
    `${win.location.pathname}${win.location.search}${rest ? `#${rest}` : ''}`,
  );
  if (!TOKEN_PATTERN.test(token)) return { found: true, changed: false };
  const changed = readToken(win) !== token;
  storeToken(win, token);
  return { found: true, changed };
}

/**
 * Runs the bootstrap once at startup and again whenever a `#token=` is pasted into an open
 * tab (a fragment-only navigation does not reload the page): a new token reloads the page so
 * every client and stream starts over with it.
 */
export function installTokenBootstrap(win: TokenWindow | undefined = browserWindow()): void {
  if (!win) return;
  takeTokenFromFragment(win);
  win.addEventListener?.('hashchange', () => {
    if (takeTokenFromFragment(win).changed) win.location.reload();
  });
}

function browserWindow(): TokenWindow | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as TokenWindow);
}
