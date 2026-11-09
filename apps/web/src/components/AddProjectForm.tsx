import { SCAN_DEPTH_DEFAULT, SCAN_DEPTH_MAX, TEST_IDS } from '@octopus-diff/contracts';
import { useEffect, useId, useRef, useState } from 'react';
import { useUi } from '../state/ui.tsx';
import { AddJobPanel, useAddFormPresence } from './AddJobStatus.tsx';
import { FolderIcon, FolderPlusIcon, RepoIcon } from './bits.tsx';
import {
  type FolderBrowser,
  FolderKeyHints,
  FolderRows,
  type OpenTarget,
  useFolderBrowser,
  useFolderStart,
} from './FolderBrowser.tsx';

/** Where the form is shown: the first-run screen labels its main button "Continue". */
export type AddProjectFormVariant = 'onboarding' | 'dialog' | 'settings';

const ACTION_LABEL = {
  watch: 'Watch this folder',
  add: 'Add this repository',
  open: 'Open it',
} as const;
const BUSY_LABEL = { watch: 'Watching…', add: 'Adding…', open: 'Opening…' } as const;

/** One line under the list: what is selected and what the main button will do with it. */
function SelectionSummary({ browser }: { browser: FolderBrowser }) {
  const { target, primary, canSubmit } = browser;
  const kind = target?.kind;
  const Icon = kind === 'repo' || kind === 'gitfile' ? RepoIcon : FolderIcon;
  return (
    <div
      data-testid="add-selection"
      data-action={canSubmit ? primary : ''}
      aria-live="polite"
      className="flex min-h-5 items-center gap-1.5 text-muted"
    >
      {target && target.exists !== false && (
        <Icon
          size={13}
          className={`shrink-0 ${kind === 'repo' || kind === 'gitfile' ? 'text-accent' : ''}`}
        />
      )}
      <span className="min-w-0">{browser.status}</span>
    </div>
  );
}

/**
 * Add a repository or watch a folder by browsing the daemon's filesystem (DECISIONS: folder
 * picker). The location text is the browser: the folder part is listed, the last segment filters;
 * a click on a folder opens it, and the main button (or Enter) adds or watches what the text
 * points at. What happens next shows in the status panel (`AddJobPanel`), and as a toast once the
 * form is gone. `onOpen` (the dialog): adding a repository, or picking one already added, opens it.
 */
export function AddProjectForm({
  onOpen,
  autoFocus = false,
  variant = onOpen ? 'dialog' : 'settings',
}: {
  onOpen?: (target: OpenTarget) => void;
  autoFocus?: boolean;
  variant?: AddProjectFormVariant;
}) {
  useAddFormPresence();
  const working = useUi((s) => s.addJob?.state === 'working');
  const start = useFolderStart();
  const [text, setText] = useState(start.text);
  const [depth, setDepth] = useState(SCAN_DEPTH_DEFAULT);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const browser = useFolderBrowser({ text, setText, depth, onOpen });
  const { shown, activeRow, primary } = browser;
  /** The action that is not on the main button. */
  const secondary = primary === 'watch' ? 'add' : 'watch';
  const onboarding = variant === 'onboarding';
  const busy = primary === 'watch' ? browser.addScanRoot.isPending : browser.addProject.isPending;
  const canSubmit = browser.canSubmit && !working;
  // The first-run screen has nothing else to do: start in the text box (dialogs focus their
  // `data-autofocus` element themselves).
  useEffect(() => {
    if (onboarding) inputRef.current?.focus();
  }, [onboarding]);
  const mainLabel = busy ? BUSY_LABEL[primary] : onboarding ? 'Continue' : ACTION_LABEL[primary];

  return (
    <div
      data-testid={TEST_IDS.folderPicker}
      data-path={browser.current?.path ?? ''}
      data-variant={variant}
      className="flex flex-col gap-2 text-xs"
    >
      {!onboarding && (
        <p className="text-muted">
          Watch a folder to add every repository and worktree inside it and keep them in sync, or
          add one repository. Nothing is ever written to a repository.
        </p>
      )}

      <div className="flex items-center gap-1">
        <label htmlFor={`${listId}-input`} className="font-semibold">
          {onboarding ? 'Pick a folder or a repository' : 'Folder'}
        </label>
        <span className="ml-auto flex gap-1">
          {shown?.places.map((place) => (
            <button
              key={place.path}
              type="button"
              className="od-btn od-btn-ghost text-muted"
              title={place.path}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => browser.goTo(place.path)}
            >
              {place.label}
            </button>
          ))}
        </span>
      </div>

      <div className="relative">
        <FolderPlusIcon
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"
        />
        <input
          ref={inputRef}
          id={`${listId}-input`}
          name="folderPath"
          data-testid={TEST_IDS.folderPickerInput}
          data-autofocus={autoFocus ? 'true' : undefined}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${listId}-list`}
          aria-activedescendant={activeRow ? `${listId}-list-row-${browser.active}` : undefined}
          aria-autocomplete="list"
          value={text}
          onChange={(e) => browser.change(e.target.value)}
          onKeyDown={(e) => {
            // While a scan runs, Enter must not start another one.
            if (e.key === 'Enter' && working && !activeRow) {
              e.preventDefault();
              return;
            }
            browser.onKeyDown(e);
          }}
          placeholder="Enter a path (e.g. ~/code/my-app)"
          autoComplete="off"
          spellCheck={false}
          className="od-input w-full pl-8 font-mono"
        />
      </div>

      <FolderRows
        browser={browser}
        listId={`${listId}-list`}
        className={`${onboarding ? 'h-48' : 'h-56'} rounded-md border border-line`}
      />

      <SelectionSummary browser={browser} />

      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1 text-muted">
          <label htmlFor={`${listId}-depth`}>Watch depth</label>
          <input
            id={`${listId}-depth`}
            type="number"
            name="depth"
            inputMode="numeric"
            min={0}
            max={SCAN_DEPTH_MAX}
            value={depth}
            title="How many folder levels below the watched folder to look for repositories"
            onChange={(e) =>
              setDepth(Math.max(0, Math.min(SCAN_DEPTH_MAX, Number(e.target.value) || 0)))
            }
            className="od-input w-14 px-1.5"
          />
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid={
              secondary === 'add' ? TEST_IDS.addProjectSubmit : TEST_IDS.addScanRootSubmit
            }
            disabled={!canSubmit}
            onClick={() => browser.submit(secondary)}
            className="od-btn od-btn-ghost px-2 text-muted"
          >
            {secondary === 'add'
              ? browser.addProject.isPending
                ? 'Adding…'
                : 'Add as one repository'
              : browser.addScanRoot.isPending
                ? 'Watching…'
                : 'Watch this folder instead'}
          </button>
          <button
            type="button"
            data-testid={
              primary === 'watch'
                ? TEST_IDS.addScanRootSubmit
                : primary === 'add'
                  ? TEST_IDS.addProjectSubmit
                  : 'add-open-submit'
            }
            data-action={primary}
            data-main="true"
            disabled={!canSubmit}
            title={`${ACTION_LABEL[primary]} (${browser.shortcut})`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => browser.submit(primary)}
            className="od-btn od-btn-primary gap-1.5 px-3"
          >
            <span>{mainLabel}</span>
            <kbd className="pointer-events-none opacity-80">{browser.shortcut}</kbd>
          </button>
        </span>
      </div>

      <FolderKeyHints browser={browser} close={onOpen !== undefined} />

      <AddJobPanel onRetry={() => inputRef.current?.focus()} />
    </div>
  );
}
