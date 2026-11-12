import { TEST_IDS } from '@octopus-diff/contracts';
import { useEffect } from 'react';
import { eyeApplies } from '../lib/model.ts';
import { ALL_ON_BRANCH } from '../lib/scopeLabels.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { useUi, useUiStore } from '../state/ui.tsx';
import { EyeIcon, ToggleButton, TreeIcon } from './bits.tsx';
import { MarkAllButton } from './MarkAllButton.tsx';
import { ORIGIN_TEST_IDS } from './OriginGroupHeader.tsx';
import { ScopeSelect } from './ScopeSelect.tsx';

export const TREE_VIEW_TEST_ID = 'tree-view-toggle';

/**
 * Over the file list (docs/TOOLBAR.md §3.2): what the list shows (the scope), the two list
 * options (reviewed files shown or hidden, list or tree) and the bulk action for what is shown.
 * Only list controls live here: the diff's options sit in the diff header, the worktree's facts
 * in the context bar.
 */
export function FilePaneHeader() {
  const model = useAppModel();
  const commands = useCommandsContext();
  const layout = useUi((s) => s.fileListLayout);
  const inbox = model.view.kind === 'inbox';
  const store = useUiStore();
  const fromMainOnly = useUi((s) => s.fromMainOnly);
  const branchToggleFrom = useUi((s) => s.branchToggleFrom);
  const scope = model.scope;
  // The toggle remembers where it came from; leaving All on branch any other way forgets it.
  useEffect(() => {
    if (branchToggleFrom && scope.kind !== 'branch') store.setState({ branchToggleFrom: null });
  }, [branchToggleFrom, scope.kind, store]);
  const onlyBranch = scope.kind === 'branch' && branchToggleFrom !== null;
  // A mixed file shows as its own change in All on branch: the toggle is offered where the list
  // has mixed files, and stays (on) while it is the reason for the scope.
  const showBranchToggle = onlyBranch || (scope.kind !== 'branch' && model.mixedCount > 0);
  const showChip = model.fromMain.count > 0 || fromMainOnly;
  // All on branch lists everything and To review what is left: the eye is only for the others.
  const eye = eyeApplies(model.scope.kind);
  return (
    <div
      role="toolbar"
      aria-label="File list options"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5"
    >
      <ScopeSelect />
      {showBranchToggle && (
        <ToggleButton
          variant="chip"
          testId={ORIGIN_TEST_IDS.branchToggle}
          pressed={onlyBranch}
          title={
            onlyBranch
              ? "Back to the list with the default branch's part of mixed files"
              : "Some files were changed on the default branch too (+main). Show only this branch's changes: the All on branch list"
          }
          onClick={() => {
            if (onlyBranch && branchToggleFrom) {
              store.setState({ scope: branchToggleFrom, branchToggleFrom: null });
            } else store.setState({ scope: ALL_ON_BRANCH, branchToggleFrom: scope });
          }}
        >
          Only this branch's changes
        </ToggleButton>
      )}
      <span className="ml-auto flex items-center gap-1">
        {showChip && (
          <ToggleButton
            variant="chip"
            testId={ORIGIN_TEST_IDS.chip}
            pressed={fromMainOnly}
            extra={{ 'data-count': String(model.fromMain.count) }}
            title={`Show only the files that came from ${model.fromMain.ref} (a merge, rebase or update) (m)`}
            onClick={commands.toggleFromMain}
          >
            From {model.fromMain.ref} ({model.fromMain.count})
          </ToggleButton>
        )}
        {eye && (
          <button
            type="button"
            data-testid={TEST_IDS.showReviewedToggle}
            aria-pressed={model.showsReviewed}
            onClick={commands.toggleShowReviewed}
            title="Show reviewed files (h)"
            aria-label="Show reviewed files"
            className="od-btn od-btn-ghost od-btn-icon"
          >
            <EyeIcon />
          </button>
        )}
        {!inbox && (
          <button
            type="button"
            data-testid={TREE_VIEW_TEST_ID}
            aria-pressed={layout === 'tree'}
            onClick={commands.toggleTreeLayout}
            title="Show the files as a directory tree"
            aria-label="Tree view"
            className="od-btn od-btn-ghost od-btn-icon"
          >
            <TreeIcon />
          </button>
        )}
        <MarkAllButton compact />
      </span>
    </div>
  );
}
