// @vitest-environment jsdom
import type { ApiClient } from '@octopus-diff/contracts';
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FOCUS_KEEPALIVE_MS, useFocusReporting } from '../src/api/hooks.ts';
import { ApiContext } from '../src/api/queries.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup() {
  const setFocus = vi.fn(async () => ({ ok: true as const }));
  const api = { setFocus } as unknown as ApiClient;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
  );
  return { setFocus, wrapper };
}

describe('useFocusReporting keep-alive (#8)', () => {
  it('reports once, then again every few minutes while the tab stays visible', async () => {
    const { setFocus, wrapper } = setup();
    renderHook(() => useFocusReporting('w1', 'p1'), { wrapper });
    await vi.advanceTimersByTimeAsync(300);
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenLastCalledWith({ worktreeId: 'w1', projectId: 'p1' });
    await vi.advanceTimersByTimeAsync(FOCUS_KEEPALIVE_MS + 300);
    expect(setFocus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FOCUS_KEEPALIVE_MS + 300);
    expect(setFocus).toHaveBeenCalledTimes(3);
  });

  it('stays quiet while the tab is hidden, and says so once', async () => {
    const { setFocus, wrapper } = setup();
    renderHook(() => useFocusReporting('w1'), { wrapper });
    await vi.advanceTimersByTimeAsync(300);
    expect(setFocus).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(300);
    expect(setFocus).toHaveBeenLastCalledWith({ worktreeId: null });
    expect(setFocus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3 * FOCUS_KEEPALIVE_MS);
    expect(setFocus).toHaveBeenCalledTimes(2);
  });
});
