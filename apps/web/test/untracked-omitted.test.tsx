// @vitest-environment jsdom
/** #43: the notice over the file list when the daemon left untracked files out. */
import { FilesResponseSchema, type UntrackedOmission } from '@octopus-diff/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UNTRACKED_OMITTED_TEST_ID,
  UntrackedOmittedNotice,
} from '../src/components/UntrackedOmittedNotice.tsx';
import { createUiStore, UiStoreProvider } from '../src/state/ui.tsx';

afterEach(cleanup);

const OMISSION: UntrackedOmission = {
  count: 30_000,
  limit: 2000,
  directories: [
    { path: 'packages/a/node_modules', count: 18_000, ignoreLine: 'node_modules/' },
    { path: 'packages/b/node_modules', count: 9000, ignoreLine: 'node_modules/' },
    { path: 'scratch/many', count: 3000, ignoreLine: '/scratch/many/' },
  ],
};

function show(omission: UntrackedOmission | undefined) {
  return render(
    <UiStoreProvider store={createUiStore({}, false)}>
      <UntrackedOmittedNotice omission={omission} />
    </UiStoreProvider>,
  );
}

describe('UntrackedOmittedNotice (#43)', () => {
  it('says how many files are not listed, where, and offers each ignore line once', () => {
    show(OMISSION);
    const note = screen.getByTestId(UNTRACKED_OMITTED_TEST_ID);
    expect(note.dataset.count).toBe('30000');
    expect(note.textContent).toContain('30,000 untracked files not listed (more than 2,000)');
    expect(note.textContent).toContain('packages/a/node_modules/ (18,000)');
    // Two directories share `node_modules/`: one line to copy, plus the anchored one.
    expect([...note.querySelectorAll('code')].map((c) => c.textContent)).toEqual([
      'node_modules/',
      '/scratch/many/',
    ]);
    expect(screen.getByRole('button', { name: 'Copy node_modules/' })).toBeTruthy();
  });

  it('shows nothing without an omission (older daemons, under the cap)', () => {
    show(undefined);
    expect(screen.queryByTestId(UNTRACKED_OMITTED_TEST_ID)).toBeNull();
  });

  it('the files response keeps the field through the client schema', () => {
    const parsed = FilesResponseSchema.parse({
      worktreeId: '0123456789abcdef',
      scope: { kind: 'working' },
      stateHash: 'abc',
      files: [],
      untrackedOmitted: OMISSION,
    });
    expect(parsed.untrackedOmitted).toEqual(OMISSION);
  });
});
