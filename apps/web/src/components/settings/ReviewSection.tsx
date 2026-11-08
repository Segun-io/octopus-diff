import { TEST_IDS } from '@octopus-diff/contracts';
import { useId } from 'react';
import { useProjectsQuery } from '../../api/queries.ts';
import {
  useScanRootsQuery,
  useSetReviewPolicy,
  useSettingsQuery,
  useUpdateSettings,
} from '../../api/settings.ts';
import { describeTarget } from '../../lib/policy.ts';
import { SettingRow, SmallButton, Switch, Where } from './controls.tsx';

/** Settings → Review: the daemon-wide default and every explicit override. */
export function ReviewSection() {
  const settings = useSettingsQuery();
  const update = useUpdateSettings();
  const setPolicy = useSetReviewPolicy();
  const projects = useProjectsQuery();
  const scanRoots = useScanRootsQuery(settings.data !== null);
  const id = useId();

  if (settings.data === undefined) {
    return (
      <p className="text-xs text-muted">
        {settings.isError ? 'Could not load settings.' : 'Loading…'}
      </p>
    );
  }
  if (settings.data === null) {
    return (
      <p className="text-xs text-muted">
        This daemon has no settings API. Review is on everywhere; update octopus-diff to control it
        per folder, project, branch or worktree.
      </p>
    );
  }
  const data = settings.data;
  const ctx = {
    projects: (projects.data?.projects ?? []).map((p) => p.project),
    worktrees: (projects.data?.projects ?? []).flatMap((p) => p.worktrees.map((w) => w.worktree)),
    scanRoots: scanRoots.data?.scanRoots ?? [],
  };
  const overrides = [...data.overrides].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div>
      <Where kind="daemon" />
      <SettingRow
        label="Review on by default"
        description="Applies to everything without an override of its own or of a parent: every new repository, worktree and branch follows this. Off makes review opt-in."
        htmlFor={id}
      >
        <Switch
          id={id}
          label="Review on by default"
          testId={TEST_IDS.settingsReviewDefault}
          checked={data.settings.review.defaultEnabled}
          disabled={update.isPending}
          onChange={(next) => update.mutate({ review: { defaultEnabled: next } })}
        />
      </SettingRow>
      <div className="py-2.5">
        <p className="text-xs font-medium">Overrides</p>
        <p className="mt-0.5 text-[11px] text-muted">
          Most specific wins: worktree, then branch, project, folder, then the default. Set them
          from the review chip above a worktree’s files or from the sidebar menus.
        </p>
        {overrides.length === 0 ? (
          <p className="mt-2 text-[11px] text-faint">
            No overrides: everything follows the default.
          </p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr>
                <th className="od-th">Target</th>
                <th className="od-th">Level</th>
                <th className="od-th">Review</th>
                <th className="od-th" />
              </tr>
            </thead>
            <tbody>
              {overrides.map((o) => {
                const d = describeTarget(o.target, ctx);
                const key = JSON.stringify(o.target);
                return (
                  <tr key={key} className="border-t border-line" data-override-kind={d.kind}>
                    <td className="max-w-80 truncate py-1.5 pr-3 font-mono" title={d.label}>
                      {d.parts ? (
                        <>
                          {d.parts[0]} <span className="text-muted">{d.parts[1]}</span>
                        </>
                      ) : (
                        d.label
                      )}
                      {!d.exists && <span className="ml-1 text-faint">(gone)</span>}
                    </td>
                    <td className="py-1.5 pr-3 text-muted">{d.detail}</td>
                    <td className="py-1.5 pr-3">
                      <span className={o.enabled ? 'text-add' : 'text-muted'}>
                        {o.enabled ? 'on' : 'off'}
                      </span>
                    </td>
                    <td className="py-1.5 text-right">
                      <SmallButton
                        onClick={() => setPolicy.mutate({ target: o.target, enabled: null })}
                        title="Remove the override; inherit again"
                        disabled={setPolicy.isPending}
                      >
                        Inherit
                      </SmallButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
