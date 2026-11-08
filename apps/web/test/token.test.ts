// @vitest-environment jsdom
import { TOKEN_STORAGE_KEY } from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserApiClient } from '../src/api/queries.ts';
import {
  installTokenBootstrap,
  readToken,
  type TokenWindow,
  takeTokenFromFragment,
} from '../src/api/token.ts';

const TOKEN = 'tok_0123456789-abcdefXYZ';

/** A window whose address bar is `url`; replaceState/reload are recorded. */
function fakeWindow(url: string, storage: Storage = localStorage) {
  const u = new URL(url);
  const listeners: Array<() => void> = [];
  const win = {
    location: {
      hash: u.hash,
      pathname: u.pathname,
      search: u.search,
      reload: vi.fn(),
    },
    history: {
      state: { keep: true },
      replaceState: vi.fn((_state: unknown, _title: string, next: string) => {
        const n = new URL(next, u.origin);
        win.location.hash = n.hash;
        win.location.pathname = n.pathname;
        win.location.search = n.search;
      }),
    },
    localStorage: storage,
    addEventListener: (_type: 'hashchange', listener: () => void) => listeners.push(listener),
    navigate(hash: string) {
      win.location.hash = hash;
      for (const l of listeners) l();
    },
  };
  return win satisfies TokenWindow;
}

beforeEach(() => {
  localStorage.clear();
});

describe('token bootstrap (#token= → localStorage)', () => {
  it('moves the token into localStorage and strips it from the address bar', () => {
    const win = fakeWindow(`http://127.0.0.1:7428/some/route?x=1#token=${TOKEN}`);
    expect(takeTokenFromFragment(win)).toEqual({ found: true, changed: true });
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    expect(win.history.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/some/route?x=1');
    expect(win.location.hash).toBe('');
    expect(readToken(win)).toBe(TOKEN);
  });

  it('keeps other fragment parameters', () => {
    const win = fakeWindow(`http://127.0.0.1:7428/#a=1&token=${TOKEN}&b=2`);
    takeTokenFromFragment(win);
    expect(win.history.replaceState).toHaveBeenCalledWith({ keep: true }, '', '/#a=1&b=2');
  });

  it('does nothing without a token in the fragment', () => {
    for (const url of ['http://127.0.0.1:7428/', 'http://127.0.0.1:7428/#other=1']) {
      const win = fakeWindow(url);
      expect(takeTokenFromFragment(win)).toEqual({ found: false, changed: false });
      expect(win.history.replaceState).not.toHaveBeenCalled();
    }
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('strips but does not store an invalid token', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const win = fakeWindow('http://127.0.0.1:7428/#token=bad%20token');
    expect(takeTokenFromFragment(win)).toEqual({ found: true, changed: false });
    expect(win.location.hash).toBe('');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });

  it('reports an unchanged token, and ignores invalid stored values', () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    expect(takeTokenFromFragment(fakeWindow(`http://h:1/#token=${TOKEN}`)).changed).toBe(false);
    localStorage.setItem(TOKEN_STORAGE_KEY, 'not a token');
    expect(readToken(fakeWindow('http://h:1/'))).not.toBe('not a token');
  });

  it('picks up a token pasted into an open tab: reload only when it changed', () => {
    const win = fakeWindow('http://127.0.0.1:7428/');
    installTokenBootstrap(win);
    expect(win.location.reload).not.toHaveBeenCalled();
    win.navigate(`#token=${TOKEN}`);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toBe('');
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    win.navigate(`#token=${TOKEN}`);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toBe('');
  });

  it('strips the fragment from the real address bar (jsdom)', () => {
    window.history.replaceState(null, '', `/inbox?q=1#token=${TOKEN}`);
    installTokenBootstrap();
    expect(window.location.href).toBe(`${window.location.origin}/inbox?q=1`);
    expect(window.location.href).not.toContain(TOKEN);
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
  });
});

describe('browser API client', () => {
  it('sends the stored token as a bearer header and never sends cookies', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN);
    const calls: RequestInit[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(JSON.stringify({ projects: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await createBrowserApiClient().listProjects();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(((calls[0]?.headers ?? {}) as Record<string, string>).authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(calls[0]?.credentials).toBe('omit');
  });

  it('sends no authorization header without a token', async () => {
    const calls: RequestInit[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response('{"error":{"code":"unauthorized","message":"missing token"}}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await expect(createBrowserApiClient(null).listProjects()).rejects.toMatchObject({
        code: 'unauthorized',
      });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(((calls[0]?.headers ?? {}) as Record<string, string>).authorization).toBeUndefined();
  });
});
