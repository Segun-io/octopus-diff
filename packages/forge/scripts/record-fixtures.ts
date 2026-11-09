/**
 * Records the raw GraphQL responses the parser tests use (`test/fixtures/*.json`), through the
 * same allowlisted runner the daemon uses. Public repositories only; needs a signed-in `gh` and
 * (for GitLab) a `glab` binary, which may be signed out (gitlab.com's public GraphQL).
 *
 *   pnpm exec tsx --conditions=@octopus-diff/source packages/forge/scripts/record-fixtures.ts \
 *     [--glab /path/to/glab]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGithubConversationQuery,
  buildGithubDetailQuery,
  buildGithubRepositoryQuery,
  buildGitlabConversationQuery,
  buildGitlabDetailQuery,
  buildGitlabRepositoryQuery,
  ForgeCli,
} from '../src/index.js';

const GITHUB = { owner: 'pingdotgg', name: 't3code', number: 32830 };
const GITLAB = { fullPath: 'gitlab-org/cli', iid: '4230' };

const glabIndex = process.argv.indexOf('--glab');
const glab = glabIndex === -1 ? undefined : process.argv[glabIndex + 1];
const cli = new ForgeCli(glab ? { binaries: { gitlab: glab } } : {});
const dir = path.join(import.meta.dirname, '..', 'test', 'fixtures');

async function record(
  file: string,
  kind: 'github' | 'gitlab',
  query: string,
  fields: Record<string, string>,
) {
  const host = kind === 'github' ? 'github.com' : 'gitlab.com';
  const args = ['api', 'graphql', '--hostname', host, '--raw-field', `query=${query}`];
  for (const [k, v] of Object.entries(fields)) args.push('--raw-field', `${k}=${v}`);
  const result = await cli.run(kind, args, { host });
  if (result.exitCode !== 0) throw new Error(`${file}: ${result.stderr}`);
  const json = JSON.parse(result.stdout);
  writeFileSync(path.join(dir, file), `${JSON.stringify(json, null, 2)}\n`);
  console.log(`${file}: ${result.stdout.length} bytes`);
}

const gh = { owner: GITHUB.owner, name: GITHUB.name };
await record('github-repository.json', 'github', buildGithubRepositoryQuery(), gh);
await record('github-detail.json', 'github', buildGithubDetailQuery(GITHUB.number, 'full'), gh);
await record('github-conversation.json', 'github', buildGithubConversationQuery(GITHUB.number), gh);
if (glab) {
  await record('gitlab-repository.json', 'gitlab', buildGitlabRepositoryQuery('full'), {
    fullPath: GITLAB.fullPath,
  });
  await record('gitlab-detail.json', 'gitlab', buildGitlabDetailQuery('full'), GITLAB);
  await record('gitlab-conversation.json', 'gitlab', buildGitlabConversationQuery('full'), GITLAB);
}
