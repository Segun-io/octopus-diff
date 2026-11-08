import { TEST_IDS } from '@octopus-diff/contracts';
import { useSettingsSupport } from '../api/settings.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { CheckIcon } from './bits.tsx';

/**
 * "Mark N visible as verified" for the current view (worktree: the files after filters; Inbox:
 * everything shown). Hidden on daemons without the bulk API.
 */
export function MarkAllButton({ compact = false }: { compact?: boolean }) {
  const support = useSettingsSupport();
  const commands = useCommandsContext();
  const model = useAppModel();
  if (support !== 'ready') return null;
  const plan = commands.currentPlan(true);
  const disabled = plan.count === 0;
  const label =
    model.view.kind === 'inbox'
      ? `Mark all ${plan.count} as verified`
      : `Mark ${plan.count} visible as verified`;
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
      title={`${label} (⇧ R). Right-click a sidebar item for folders and projects.`}
      className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] ${
        disabled
          ? 'cursor-default border-line text-faint'
          : 'border-line text-muted hover:border-add hover:bg-add-soft hover:text-fg'
      }`}
    >
      <CheckIcon />
      {compact ? `Verify ${plan.count}` : label}
    </button>
  );
}
