import { SCAN_DEPTH_DEFAULT, SCAN_DEPTH_MAX, TEST_IDS } from '@octopus-diff/contracts';
import { useId, useState } from 'react';
import { describeError } from '../api/queries.ts';
import { useUi } from '../state/ui.tsx';
import { FolderPlusIcon } from './bits.tsx';
import {
  FolderKeyHints,
  FolderRows,
  FolderSubmitButton,
  type OpenTarget,
  useFolderBrowser,
  useFolderStart,
} from './FolderBrowser.tsx';

/**
 * Add a repository or watch a folder by browsing the daemon's filesystem (DECISIONS: folder
 * picker). The location text is the browser: the folder part is listed, the last segment filters.
 * `onOpen` (the dialog): adding a repository, or picking one already added, opens it.
 */
export function AddProjectForm({
  onOpen,
  autoFocus = false,
}: {
  onOpen?: (target: OpenTarget) => void;
  autoFocus?: boolean;
}) {
  const scan = useUi((s) => s.scan);
  const start = useFolderStart();
  const [text, setText] = useState(start.text);
  const [depth, setDepth] = useState(SCAN_DEPTH_DEFAULT);
  const listId = useId();
  const browser = useFolderBrowser({ text, setText, depth, onOpen });
  const { shown, activeRow, primary } = browser;
  /** The action that is not on the text box's button. */
  const secondary = primary === 'watch' ? 'add' : 'watch';

  return (
    <div
      data-testid={TEST_IDS.folderPicker}
      data-path={browser.current?.path ?? ''}
      className="flex flex-col gap-2 text-xs"
    >
      <p className="text-muted">
        Watch a folder to add every repository and worktree inside it and keep them in sync, or add
        one repository. Nothing is ever written to a repository.
      </p>

      <div className="flex items-center gap-1">
        <label htmlFor={`${listId}-input`} className="font-semibold">
          Folder
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
          onKeyDown={(e) => browser.onKeyDown(e)}
          placeholder="Enter a path (e.g. ~/code/my-app)"
          autoComplete="off"
          spellCheck={false}
          className="od-input w-full pr-28 pl-8 font-mono"
        />
        <FolderSubmitButton browser={browser} />
      </div>

      <FolderRows
        browser={browser}
        listId={`${listId}-list`}
        className="h-56 rounded-md border border-line"
      />

      <p className="min-h-4 text-muted" aria-live="polite">
        {browser.status}
      </p>

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
        <button
          type="button"
          data-testid={secondary === 'add' ? TEST_IDS.addProjectSubmit : TEST_IDS.addScanRootSubmit}
          disabled={!browser.canSubmit}
          onClick={() => browser.submit(secondary)}
          className="od-btn ml-auto px-3"
        >
          {secondary === 'add'
            ? browser.addProject.isPending
              ? 'Adding…'
              : 'Add as one repository'
            : browser.addScanRoot.isPending
              ? 'Watching…'
              : 'Watch this folder'}
        </button>
      </div>

      <FolderKeyHints browser={browser} close={onOpen !== undefined} />

      <div aria-live="polite" className="min-h-4">
        {browser.error && <p className="text-danger">{describeError(browser.error).detail}</p>}
        {!browser.error && browser.message && <p className="text-muted">{browser.message}</p>}
        {scan && (
          <p className="text-muted">
            Scan {scan.state}: {scan.scannedDirs} folders, {scan.foundRepos} repositories
            {scan.message ? `. ${scan.message}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
