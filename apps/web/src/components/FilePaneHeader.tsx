import { TEST_IDS } from '@octopus-diff/contracts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { useUi } from '../state/ui.tsx';
import { EyeIcon, TreeIcon } from './bits.tsx';
import { MarkAllButton } from './MarkAllButton.tsx';
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
  // To review lists what is left, never reviewed files: the eye shows "off" and does nothing.
  const inReview = model.scope.kind === 'review';
  return (
    <div
      role="toolbar"
      aria-label="File list options"
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5"
    >
      <ScopeSelect />
      <span className="ml-auto flex items-center gap-1">
        <button
          type="button"
          data-testid={TEST_IDS.showReviewedToggle}
          aria-pressed={model.showsReviewed}
          aria-disabled={inReview}
          onClick={commands.toggleShowReviewed}
          title={inReview ? 'To review lists unreviewed files only' : 'Show reviewed files (h)'}
          aria-label="Show reviewed files"
          className="od-btn od-btn-ghost od-btn-icon"
        >
          <EyeIcon />
        </button>
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
