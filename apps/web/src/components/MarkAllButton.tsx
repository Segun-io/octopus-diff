import { TEST_IDS } from '@octopus-diff/contracts';
import { useSettingsSupport } from '../api/settings.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { CheckIcon } from './bits.tsx';

/**
 * "Review all" (⇧R) for the open worktree (the files after the list's options): one verb,
 * "Reviewed" (docs/STATUS-FLOW.md §2.3). Every worktree, a project or a folder: the palette and
 * the Overviews. Hidden on daemons without the bulk API.
 */
export function MarkAllButton({ compact = false }: { compact?: boolean }) {
  const support = useSettingsSupport();
  const commands = useCommandsContext();
  if (support !== 'ready') return null;
  const plan = commands.currentPlan(true);
  const disabled = plan.count === 0;
  const label = `Review ${plan.count} shown`;
  return (
    <button
      type="button"
      data-testid={TEST_IDS.markAllButton}
      data-target={plan.target}
      data-count={String(plan.count)}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) commands.markAll(true);
      }}
      title={`${label} (⇧ R). Every worktree, a project or a folder: the command palette and the Overviews.`}
      className={`od-btn shrink-0 ${disabled ? '' : 'hover:border-add hover:bg-add-soft'}`}
    >
      <CheckIcon />
      {compact ? `Review ${plan.count}` : label}
    </button>
  );
}
