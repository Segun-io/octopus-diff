import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFS,
  loadPrefs,
  normalizePrefs,
  PREFS_STORAGE_KEY,
  PREFS_VERSION,
  savePrefs,
  serializePrefs,
  storedPrefsAreCurrent,
} from '../src/state/prefs.ts';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe('prefs', () => {
  it('migrates v1 prefs (string theme) to v2 and keeps every old value', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        diffMode: 'unified',
        ignoreWhitespace: true,
        showReviewed: false,
        theme: 'dark',
        fileListLayout: 'tree',
      }),
    );
    const prefs = loadPrefs(storage);
    expect(prefs).toEqual({
      ...DEFAULT_PREFS,
      diffMode: 'unified',
      ignoreWhitespace: true,
      showReviewed: false,
      theme: { mode: 'dark', light: 'octopus-light', dark: 'octopus-dark' },
      fileListLayout: 'tree',
    });
    savePrefs(prefs, storage);
    const written = JSON.parse(storage.getItem(PREFS_STORAGE_KEY) ?? '{}');
    expect(written.version).toBe(PREFS_VERSION);
    expect(written.theme).toEqual(prefs.theme);
  });

  it('returns defaults for missing, malformed or wrong-typed data', () => {
    expect(loadPrefs(new MemoryStorage())).toEqual(DEFAULT_PREFS);
    const storage = new MemoryStorage();
    storage.setItem(PREFS_STORAGE_KEY, '{not json');
    expect(loadPrefs(storage)).toEqual(DEFAULT_PREFS);
    expect(normalizePrefs({ density: 'huge', defaultScope: 'commit', collapsed: 'x' })).toEqual(
      DEFAULT_PREFS,
    );
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('round-trips v2 prefs', () => {
    const prefs = {
      ...DEFAULT_PREFS,
      density: 'comfortable' as const,
      defaultScope: 'staged' as const,
      autoAdvance: true,
      lastWorktree: 'wt-1',
      titleCount: false,
      confirmBulk: false,
      collapsed: ['a', 'b'],
      theme: { mode: 'light' as const, light: 'octopus-light', dark: 'octopus-contrast' },
    };
    expect(normalizePrefs(JSON.parse(serializePrefs(prefs)))).toEqual(prefs);
  });
});

describe('storedPrefsAreCurrent', () => {
  it('is true for nothing stored or a v2 document, false for v1 or malformed data', () => {
    const storage = new MemoryStorage();
    expect(storedPrefsAreCurrent(storage)).toBe(true);
    storage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ theme: 'light' }));
    expect(storedPrefsAreCurrent(storage)).toBe(false);
    storage.setItem(PREFS_STORAGE_KEY, '{nope');
    expect(storedPrefsAreCurrent(storage)).toBe(false);
    savePrefs(DEFAULT_PREFS, storage);
    expect(storedPrefsAreCurrent(storage)).toBe(true);
  });
});
