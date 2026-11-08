// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { PREFS_STORAGE_KEY, PREFS_VERSION } from '../src/state/prefs.ts';
import { createUiStore } from '../src/state/ui.tsx';

describe('ui store persistence', () => {
  afterEach(() => localStorage.clear());

  it('writes migrated v1 prefs back as v2 on load, keeping the old values', () => {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({ theme: 'light', diffMode: 'unified', showReviewed: false }),
    );
    const store = createUiStore();
    expect(store.getState().diffMode).toBe('unified');
    const stored = JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}');
    expect(stored).toMatchObject({
      version: PREFS_VERSION,
      theme: { mode: 'light', light: 'octopus-light', dark: 'octopus-dark' },
      diffMode: 'unified',
      showReviewed: false,
    });
  });

  it('leaves a current v2 document alone until a pref changes', () => {
    const store = createUiStore();
    expect(localStorage.getItem(PREFS_STORAGE_KEY)).toBeNull();
    store.setState({ diffMode: 'unified' });
    expect(JSON.parse(localStorage.getItem(PREFS_STORAGE_KEY) ?? '{}')).toMatchObject({
      version: PREFS_VERSION,
      diffMode: 'unified',
    });
  });
});
