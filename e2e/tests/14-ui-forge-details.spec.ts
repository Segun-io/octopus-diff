/**
 * Forge details in the browser (docs/FORGES.md "Request tab", "Repository information"):
 * (1) the project Overview's local repository facts against fixture repos, with no forge at all;
 * (2) a fake `gh` first on the daemon's PATH answers `--version`, `auth status` and each query kind
 *     (batch, repository, detail, conversation) from the recorded fixtures; a repository whose
 *     `origin` is https://github.com/octo-demo/app.git then shows the chip, the Request tab, the
 *     Overview's forge block and open requests, and no tab for a branch without a request.
 * The daemon runs in this worker process, so the PATH change is scoped to this file and restored.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject, runGit } from '@octopus-diff/fixtures';
import { REPO_ROOT } from '../support/env.js';
import { addWorktree, createRepo } from '../support/repos.js';
import { expect, test } from '../support/ui.js';

const FIXTURES = join(REPO_ROOT, 'packages', 'forge', 'test', 'fixtures');

/** A node script standing in for `gh` 2.46: read-only answers from recorded responses. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const FIXTURES = ${JSON.stringify(FIXTURES)};
if (args[0] === '--version') { console.log('gh version 2.46.0 (fake)'); process.exit(0); }
if (args[0] === 'auth' && args[1] === 'status') {
  console.error('github.com\\n  \\u2713 Logged in to github.com account octo (keyring)\\n  - Token: gho_****');
  process.exit(0);
}
if (args[0] !== 'api' || args[1] !== 'graphql') process.exit(2);
const fields = {};
for (let i = 4; i < args.length; i += 2) {
  const f = args[i + 1];
  const eq = f.indexOf('=');
  fields[f.slice(0, eq)] = f.slice(eq + 1);
}
const op = /^query (\\w+)/.exec(fields.query)[1];
const read = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
// No network in the browser: drop avatars so nothing tries to load.
const scrub = (v) => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = k === 'avatarUrl' ? null : scrub(x);
    return out;
  }
  return v;
};
const pr = {
  number: 42, title: 'Login with passkeys', url: 'https://github.com/octo-demo/app/pull/42',
  state: 'OPEN', isDraft: false, createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-08T10:00:00Z',
  baseRefName: 'main', headRefName: 'feature/login', headRefOid: null, isCrossRepository: false,
  headRepository: { nameWithOwner: 'octo-demo/app' }, author: { login: 'octo' },
  reviewDecision: 'REVIEW_REQUIRED', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED',
  totalCommentsCount: 3, additions: 120, deletions: 8, changedFiles: 4,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING', contexts: { totalCount: 3,
    checkRunCountsByState: [{ state: 'SUCCESS', count: 2 }, { state: 'IN_PROGRESS', count: 1 }],
    statusContextCountsByState: [] } } } }] },
};
let body;
if (op === 'OctopusDiffPullRequests') {
  const repository = { };
  for (const [k, v] of Object.entries(fields)) {
    if (/^b\\d+$/.test(k)) repository[k] = { nodes: v === 'feature/login' ? [pr] : [] };
  }
  body = { data: { rateLimit: { cost: 1, remaining: 4999 }, repository } };
} else if (op === 'OctopusDiffRepository') {
  const fixture = read('github-repository.json');
  const repo = fixture.data.repository;
  repo.nameWithOwner = 'octo-demo/app';
  repo.url = 'https://github.com/octo-demo/app';
  repo.description = 'The demo app';
  repo.recent.nodes = [{ ...pr, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }, ...repo.recent.nodes.slice(0, 2)];
  body = fixture;
} else if (op === 'OctopusDiffPullRequestDetail') {
  const fixture = read('github-detail.json');
  Object.assign(fixture.data.repository.pullRequest, {
    number: 42, title: 'Login with passkeys', url: 'https://github.com/octo-demo/app/pull/42',
    state: 'OPEN', mergedAt: null, closedAt: null, mergedBy: null, mergeStateStatus: 'BLOCKED',
    baseRefName: 'main', headRefName: 'feature/login',
    body: '## Passkeys\\n\\nAdds **passkey** login. See #7.\\n\\n<script>window.__pwned = 1</script>',
  });
  body = fixture;
} else if (op === 'OctopusDiffPullRequestConversation') {
  body = read('github-conversation.json');
} else {
  process.exit(3);
}
process.stdout.write(JSON.stringify(scrub(body)));
`;

test.describe('forge details (UI)', () => {
  test('project Overview: local repository facts with no forge', async ({
    manifest,
    daemon,
    ui,
  }) => {
    const project = findProject(manifest, 'alpha');
    await ui.open(daemon.authUrl);
    await ui.openProjectOverview(project.name);
    const local = ui.byTestId(TEST_IDS.repoInfoLocal);
    await expect(local).toContainText(/\d+ branch(es)? · \d+ tags? · \d+ worktrees?/);
    await expect(local).toContainText('Default branch');
    await expect(local).toContainText('Last commit');
    // No remote on a forge: no forge block, and no forge CLI was ever started.
    await expect(ui.byTestId(TEST_IDS.repoInfoForge)).toHaveCount(0);
  });

  test.describe('with a fake gh on PATH', () => {
    let previousPath: string | undefined;

    test.beforeAll(async ({ manifest }) => {
      const bin = join(manifest.root, `fake-gh-${process.pid}`);
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'gh'), FAKE_GH);
      await chmod(join(bin, 'gh'), 0o755);
      previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    });

    test.afterAll(() => {
      process.env.PATH = previousPath;
    });

    test('chip, Request tab, Overview forge block and open requests; no tab without a request', async ({
      manifest,
      gitEnv,
      daemon,
      ui,
    }) => {
      const parent = join(manifest.root, `forge-e2e-${Date.now()}`);
      const repo = await createRepo(parent, 'app', gitEnv);
      await runGit(['remote', 'add', 'origin', 'https://github.com/octo-demo/app.git'], {
        cwd: repo.dir,
        env: gitEnv,
      });
      const login = await addWorktree(repo, join(parent, 'app-login'), 'feature/login', gitEnv);
      const plain = await addWorktree(repo, join(parent, 'app-plain'), 'feature/none', gitEnv);
      await daemon.client.addProject({ path: repo.dir });
      await ui.open(daemon.authUrl);

      // The batch query matched PR #42 to the login worktree only.
      const chip = ui.worktreeItem(login).getByTestId(TEST_IDS.changeRequestChip);
      await expect(chip).toHaveAttribute('data-number', '42', { timeout: 20_000 });
      await expect(ui.worktreeItem(plain).getByTestId(TEST_IDS.changeRequestChip)).toHaveCount(0);

      // The Request tab.
      await ui.selectWorktree(login);
      const tabs = ui.byTestId(TEST_IDS.worktreeTabs);
      await tabs.locator('[data-tab="request"]').click();
      const view = ui.byTestId(TEST_IDS.requestView);
      await expect(view).toHaveAttribute('data-status', 'ok');
      await expect(view.getByRole('heading', { level: 1 })).toHaveText('Login with passkeys');
      await expect(view.getByTestId(TEST_IDS.markdown).first()).toContainText(
        'Adds passkey login.',
      );
      expect(
        await ui.page.evaluate(() => (window as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      // Checks start closed when nothing needs attention.
      const checks = view.getByRole('button', { name: /^Checks/ });
      if ((await checks.getAttribute('aria-expanded')) === 'false') await checks.click();
      await expect(view.getByTestId(TEST_IDS.requestCheck).first()).toBeVisible();
      await expect(view.getByTestId(TEST_IDS.requestConversationItem).first()).toBeVisible();
      await view.locator('[data-tab="files"]').click();
      await expect(view.getByTestId(TEST_IDS.requestFile).first()).toBeVisible();

      // A branch without a request: no tab control, the Changes view.
      await ui.selectWorktree(plain);
      await expect(ui.byTestId(TEST_IDS.worktreeTabs)).toHaveCount(0);
      await expect(ui.byTestId(TEST_IDS.requestView)).toHaveCount(0);

      // The project Overview: local and forge facts, open requests joined to the worktree.
      await ui.openProjectOverview('app');
      await expect(ui.byTestId(TEST_IDS.repoInfoLocal)).toContainText('github.com/octo-demo/app');
      const forge = ui.byTestId(TEST_IDS.repoInfoForge);
      await expect(forge).toHaveAttribute('data-status', 'ok');
      await expect(forge).toContainText('The demo app');
      await ui.byTestId(TEST_IDS.overviewTab).and(ui.page.locator('[data-tab="requests"]')).click();
      const mine = ui.byTestId(TEST_IDS.repoOpenRequest).and(ui.page.locator('[data-number="42"]'));
      await expect(mine).toHaveAttribute('data-worktree', login);
      await mine.click();
      await expect(ui.byTestId(TEST_IDS.requestView)).toHaveAttribute('data-status', 'ok');

      // The UI CSP now allows the signed-in host's images.
      const response = await ui.page.request.get(daemon.url);
      expect(response.headers()['content-security-policy']).toContain(
        "img-src 'self' data: blob: https://*.githubusercontent.com https://github.com",
      );
    });
  });
});
