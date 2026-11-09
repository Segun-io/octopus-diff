// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, copyWithExecCommand } from '../src/lib/copy.ts';

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else setClipboard(undefined);
  vi.restoreAllMocks();
});

/** jsdom has no execCommand; stub it and record what was selected when it ran. */
function stubExecCommand(result: boolean) {
  const seen: string[] = [];
  const exec = vi.fn((command: string) => {
    const el = document.activeElement;
    if (command === 'copy' && el instanceof HTMLTextAreaElement) seen.push(el.value);
    return result;
  });
  Object.defineProperty(document, 'execCommand', { value: exec, configurable: true });
  return { exec, seen };
}

describe('copyText', () => {
  it('uses the async Clipboard API when there is one', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    const { exec } = stubExecCommand(true);
    await expect(copyText('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to a hidden textarea without navigator.clipboard (plain-http LAN)', async () => {
    setClipboard(undefined);
    const { exec, seen } = stubExecCommand(true);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await expect(copyText('src/a.ts')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(seen).toEqual(['src/a.ts']);
    // The textarea is gone and focus is back where it was.
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('falls back when the async API rejects', async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('denied'))) });
    const { seen } = stubExecCommand(true);
    await expect(copyText('x')).resolves.toBe(true);
    expect(seen).toEqual(['x']);
  });

  it('reports failure when nothing works', async () => {
    setClipboard(undefined);
    stubExecCommand(false);
    await expect(copyText('x')).resolves.toBe(false);
    expect(copyWithExecCommand('y')).toBe(false);
  });
});
