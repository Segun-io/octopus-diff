import { useSyncExternalStore } from 'react';
import { useUi } from '../state/ui.tsx';
import { resolveTheme } from './registry.ts';
import type { ThemeDefinition } from './tokens.ts';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function subscribeSystemDark(onChange: () => void): () => void {
  if (typeof matchMedia === 'undefined') return () => {};
  const mq = matchMedia(DARK_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getSystemDark(): boolean {
  return typeof matchMedia === 'undefined' ? true : matchMedia(DARK_QUERY).matches;
}

export function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeSystemDark, getSystemDark, () => true);
}

/** The active theme definition (preference + OS scheme, with fallbacks). */
export function useTheme(): ThemeDefinition {
  const prefs = useUi((s) => s.theme);
  const systemDark = useSystemDark();
  return resolveTheme(prefs, systemDark);
}
