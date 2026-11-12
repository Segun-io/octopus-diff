import {
  type ForgeHostOverride,
  ForgeHostSchema,
  type ProjectForgeState,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { type FormEvent, useId, useState } from 'react';
import { useForgesQuery, useRefreshForges } from '../../api/forges.ts';
import { useProjectsQuery } from '../../api/queries.ts';
import { useSettingsQuery, useUpdateSettings } from '../../api/settings.ts';
import { budgetLine, projectStatusLine } from '../../lib/forge.ts';
import { Select, SettingRow, SmallButton, Switch, Where } from './controls.tsx';

const OVERRIDE_LABELS: Record<ForgeHostOverride, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  none: 'Never query',
};

const OVERRIDE_OPTIONS = (Object.keys(OVERRIDE_LABELS) as ForgeHostOverride[]).map((value) => ({
  value,
  label: OVERRIDE_LABELS[value],
}));

/** Projects worth listing: those on a forge, or whose remote host needs a decision. */
function relevant(state: ProjectForgeState): boolean {
  if (state.forge !== null) return true;
  return (
    state.status === 'ignored' ||
    (state.status === 'no-forge' && /not recognised/.test(state.message ?? ''))
  );
}

/** Settings → Forges: pull and merge requests through the user's own `gh` / `glab`. */
export function ForgesSection() {
  const settings = useSettingsQuery();
  const update = useUpdateSettings();
  const forges = useForgesQuery();
  const refresh = useRefreshForges();
  const projects = useProjectsQuery();
  const switchId = useId();
  const [host, setHost] = useState('');
  const [kind, setKind] = useState<ForgeHostOverride>('gitlab');

  if (settings.data === undefined || forges.data === undefined) {
    return (
      <p className="text-xs text-muted">{forges.isError ? 'Could not load forges.' : 'Loading…'}</p>
    );
  }
  const forgeSettings = settings.data?.settings.forges;
  if (settings.data === null || forges.data === null || !forgeSettings) {
    return (
      <p className="text-xs text-muted">
        This daemon has no forge integration. Update octopus-diff to see pull and merge requests.
      </p>
    );
  }
  const data = forges.data;
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.project.id, p.project.name]));
  const listed = data.projects.filter(relevant);
  const overrides = Object.entries(forgeSettings.hosts).sort(([a], [b]) => a.localeCompare(b));
  const normalized = host.trim().toLowerCase();
  const hostValid = ForgeHostSchema.safeParse(normalized).success;

  const setHosts = (hosts: Record<string, ForgeHostOverride>) =>
    update.mutate({ forges: { hosts } });
  const addOverride = (event: FormEvent) => {
    event.preventDefault();
    if (!hostValid) return;
    setHosts({ ...forgeSettings.hosts, [normalized]: kind });
    setHost('');
  };

  return (
    <div>
      <Where kind="daemon" />
      <SettingRow
        label="Show pull and merge requests"
        description="Uses the GitHub CLI (gh) and GitLab CLI (glab) you are already signed in to. Read-only: octopus-diff runs their query commands only, never sees a token, and asks only about branches checked out in worktrees (not the default branch)."
        htmlFor={switchId}
      >
        <Switch
          id={switchId}
          label="Show pull and merge requests"
          testId={TEST_IDS.settingsForgesEnabled}
          checked={forgeSettings.enabled}
          disabled={update.isPending}
          onChange={(next) => update.mutate({ forges: { enabled: next } })}
        />
      </SettingRow>
      <SettingRow
        label="Load images from the forges"
        description="Avatars and pictures in descriptions and comments load from the forge hosts gh and glab are signed in to (the page's Content-Security-Policy allows those hosts only, without a referrer). Off: images show as links and the policy stays strict. Applies after a reload."
        htmlFor={`${switchId}-images`}
      >
        <Switch
          id={`${switchId}-images`}
          label="Load images from the forges"
          testId={TEST_IDS.settingsForgesImages}
          checked={forgeSettings.enabled && forgeSettings.images !== false}
          disabled={update.isPending || !forgeSettings.enabled}
          onChange={(next) => update.mutate({ forges: { images: next } })}
        />
      </SettingRow>

      <div className="border-b border-line py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-xs font-medium">Command-line tools</p>
          <span className="ml-auto" />
          <SmallButton
            onClick={() => refresh.mutate({})}
            disabled={refresh.isPending || !forgeSettings.enabled}
            title="Check the CLIs and fetch every repository again"
          >
            {refresh.isPending ? 'Checking…' : 'Check again'}
          </SmallButton>
        </div>
        {data.clis.length === 0 ? (
          <p className="mt-2 text-[11px] text-faint">
            Not checked yet: the CLIs are only started once a repository has a remote on a host.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {data.clis.map((cli) => (
              <li
                key={cli.kind}
                data-testid={TEST_IDS.forgeCliStatus}
                data-kind={cli.kind}
                data-available={String(cli.available)}
                data-auth={cli.auth}
                className="text-xs"
              >
                <span className="font-mono">{cli.executable}</span>{' '}
                {cli.available ? (
                  <span className="text-muted">
                    {(cli.version ?? 'installed').replace(
                      new RegExp(`^${cli.executable}\\s+(version\\s+)?`),
                      '',
                    )}
                  </span>
                ) : (
                  <span className="text-warn">not installed</span>
                )}
                {cli.accounts.length > 0 && (
                  <span className="text-muted">
                    {' · signed in to '}
                    {cli.accounts
                      .map((a) => (a.account ? `${a.host} (${a.account})` : a.host))
                      .join(', ')}
                  </span>
                )}
                {cli.available && cli.accounts.length === 0 && (
                  <span className="text-warn"> · not signed in</span>
                )}
                {(!cli.available || cli.accounts.length === 0) && (
                  <p className="text-[11px] text-faint">{cli.hint}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {(data.budgets?.length ?? 0) > 0 && (
        <div className="border-b border-line py-2.5">
          <p className="text-xs font-medium">Rate limit</p>
          <ul className="mt-2 space-y-1">
            {data.budgets?.map((budget) => {
              const line = budgetLine(budget);
              return (
                <li key={budget.host} className="text-xs" data-budget-state={budget.state}>
                  <span className="font-mono">{budget.host}</span>{' '}
                  <span className={line.warn ? 'text-warn' : 'text-muted'}>{line.text}</span>
                </li>
              );
            })}
          </ul>
          <p className="mt-1 text-[11px] text-faint">
            GitHub allows 5,000 points an hour per sign-in, shared with every other tool that uses
            it. octopus-diff stops automatic lookups well before that and slows down when nobody is
            looking.
          </p>
        </div>
      )}

      <div className="border-b border-line py-2.5">
        <p className="text-xs font-medium">Repositories</p>
        {listed.length === 0 ? (
          <p className="mt-2 text-[11px] text-faint">
            No repository has a remote on GitHub or GitLab.
          </p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr>
                <th className="od-th">Repository</th>
                <th className="od-th">Forge</th>
                <th className="od-th">Status</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((state) => (
                <tr
                  key={state.projectId}
                  className="border-t border-line"
                  data-forge-status={state.status}
                >
                  <td className="max-w-40 truncate py-1.5 pr-3">
                    {names.get(state.projectId) ?? state.projectId}
                  </td>
                  <td className="max-w-56 truncate py-1.5 pr-3 font-mono text-muted">
                    {state.forge ? (
                      <a
                        href={state.forge.webUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-fg hover:underline"
                        title={`${state.forge.kind === 'github' ? 'GitHub' : 'GitLab'} via remote "${state.forge.remoteName}" (${state.forge.detectedBy})`}
                      >
                        {state.forge.host}/{state.forge.repository}
                      </a>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td
                    className={`py-1.5 ${state.status === 'ok' || state.status === 'idle' ? 'text-muted' : 'text-warn'}`}
                  >
                    {projectStatusLine(state)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="py-2.5">
        <p className="text-xs font-medium">Host overrides</p>
        <p className="mt-0.5 text-[11px] text-muted">
          github.com, gitlab.com and hosts named like github or gitlab are recognised, as are hosts
          gh or glab is signed in to. Name any other self-hosted server here, or stop a host from
          being queried.
        </p>
        {overrides.length > 0 && (
          <table className="mt-2 w-full text-xs">
            <tbody>
              {overrides.map(([h, k]) => (
                <tr key={h} className="border-t border-line first:border-0">
                  <td className="py-1.5 pr-3 font-mono">{h}</td>
                  <td className="py-1.5 pr-3 text-muted">{OVERRIDE_LABELS[k]}</td>
                  <td className="py-1.5 text-right">
                    <SmallButton
                      onClick={() => {
                        const next = { ...forgeSettings.hosts };
                        delete next[h];
                        setHosts(next);
                      }}
                      disabled={update.isPending}
                    >
                      Remove
                    </SmallButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form onSubmit={addOverride} className="mt-2 flex items-center gap-2">
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="git.example.com"
            aria-label="Host"
            spellCheck={false}
            className="od-input w-56 font-mono"
          />
          <Select label="Treat as" value={kind} onChange={setKind} options={OVERRIDE_OPTIONS} />
          <button type="submit" className="od-btn" disabled={!hostValid || update.isPending}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}
