import {
  type EffectiveReviewPolicy,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSetReviewPolicy, useSettingsQuery } from '../api/settings.ts';
import type { WorktreeRow } from '../lib/model.ts';
import { policyLabel, SOURCE_LABELS } from '../lib/policy.ts';
import { useEscapeToClose } from '../lib/useEscape.ts';

type Level = Exclude<ReviewPolicyTarget['kind'], never>;

interface LevelRow {
  level: Level;
  label: string;
  target: ReviewPolicyTarget | null;
}

function levelsFor(row: WorktreeRow, folderPath: string | undefined): LevelRow[] {
  const { worktree, project } = row;
  return [
    {
      level: 'worktree',
      label: `This worktree (${worktree.branch ?? 'detached'})`,
      target: { kind: 'worktree', worktreeId: worktree.id },
    },
    {
      level: 'branch',
      label: worktree.branch ? `Branch ${worktree.branch}` : 'Branch (detached: none)',
      target: worktree.branch
        ? { kind: 'branch', projectId: project.id, branch: worktree.branch }
        : null,
    },
    {
      level: 'project',
      label: `Project ${project.name}`,
      target: { kind: 'project', projectId: project.id },
    },
    {
      level: 'folder',
      label: project.scanRootId
        ? `Folder ${folderPath ?? ''}`.trim()
        : 'Folder (added directly: none)',
      target: project.scanRootId ? { kind: 'folder', scanRootId: project.scanRootId } : null,
    },
  ];
}

/**
 * Toolbar chip for the selected worktree: shows the effective review policy and where it comes
 * from; opens a menu with On / Off / Inherit per level (worktree, branch, project, folder).
 */
export function ReviewPolicyChip({
  row,
  policy,
  folderPath,
}: {
  row: WorktreeRow;
  policy: EffectiveReviewPolicy;
  folderPath: string | undefined;
}) {
  const settings = useSettingsQuery();
  const setPolicy = useSetReviewPolicy();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const closeMenu = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);
  useEscapeToClose(open, closeMenu);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        !buttonRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    menuRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (settings.data === null || settings.data === undefined) return null; // older daemon / loading
  const overrides = new Map(
    settings.data.overrides.map((o) => [reviewTargetKey(o.target), o.enabled]),
  );
  const levels = levelsFor(row, folderPath);

  const choose = (target: ReviewPolicyTarget, enabled: boolean | null) => {
    setPolicy.mutate({ target, enabled });
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid={TEST_IDS.reviewPolicyChip}
        data-enabled={String(policy.enabled)}
        data-source={policy.source}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        title={`${policyLabel(policy)}. Click to change.`}
        className={`flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${
          policy.enabled
            ? 'border-line text-muted hover:bg-hover hover:text-fg'
            : 'border-line-strong bg-raised text-fg'
        }`}
      >
        <span
          aria-hidden="true"
          className={`h-2 w-2 rounded-full ${policy.enabled ? 'bg-add' : 'bg-faint'}`}
        />
        <span>Review {policy.enabled ? 'on' : 'off'}</span>
        <span className="text-faint">· {SOURCE_LABELS[policy.source]}</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Review policy"
          data-testid={TEST_IDS.reviewPolicyMenu}
          className="od-overlay od-fade-in absolute top-full left-0 z-30 mt-1 w-80 rounded-md p-1 text-xs"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
        >
          <p className="px-2 py-1 text-[11px] text-muted">
            Most specific wins: worktree › branch › project › folder › default.
          </p>
          {levels.map((lvl) => {
            const key = lvl.target ? reviewTargetKey(lvl.target) : null;
            const state =
              key === null
                ? null
                : overrides.has(key)
                  ? overrides.get(key)
                    ? 'on'
                    : 'off'
                  : 'inherit';
            const effectiveHere = policy.source === lvl.level;
            return (
              <div
                key={lvl.level}
                className={`flex items-center gap-2 rounded-sm px-2 py-1 ${effectiveHere ? 'bg-selected' : ''}`}
              >
                <span
                  className={`min-w-0 flex-1 truncate ${lvl.target ? '' : 'text-faint'}`}
                  title={lvl.label}
                >
                  {lvl.label}
                  {effectiveHere && <span className="ml-1 text-[10px] text-accent">decides</span>}
                </span>
                {(['on', 'off', 'inherit'] as const).map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    role="menuitemradio"
                    aria-checked={state === choice}
                    data-testid={TEST_IDS.reviewPolicyItem}
                    data-target={lvl.level}
                    data-state={choice}
                    disabled={!lvl.target || setPolicy.isPending}
                    onClick={() =>
                      lvl.target &&
                      choose(lvl.target, choice === 'inherit' ? null : choice === 'on')
                    }
                    className={`rounded-sm border px-1.5 py-0.5 text-[11px] disabled:opacity-40 ${
                      state === choice
                        ? 'border-accent bg-accent-soft text-fg'
                        : 'border-transparent text-muted hover:bg-hover hover:text-fg'
                    }`}
                  >
                    {choice === 'inherit' ? 'Inherit' : choice === 'on' ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
            );
          })}
          <p className="px-2 pt-1 pb-0.5 text-[11px] text-faint">
            Default: review {settings.data.settings.review.defaultEnabled ? 'on' : 'off'} (Settings
            → Review).
          </p>
        </div>
      )}
    </div>
  );
}
