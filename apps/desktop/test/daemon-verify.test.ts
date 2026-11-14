/** #22: before the window loads a WSL daemon's URL, Windows must reach *that* daemon (the proof). */
import { createHmac } from 'node:crypto';
import { healthProofMessage } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { verifyDaemon } from '../src/daemon-api.js';
import { TOKEN } from './fakes.js';

const health = (proof?: string) => ({
  ok: true,
  name: 'octopus-diff',
  version: '1.2.3',
  apiVersion: 1,
  git: { version: '2.43.0', supported: true },
  watcher: { mode: 'native', warnings: [] },
  startedAt: '2026-11-14T00:00:00.000Z',
  uptimeMs: 5,
  ...(proof ? { proof } : {}),
});

function fetchAnswering(answer: (url: URL, init?: RequestInit) => unknown) {
  const seen: { url: string; headers: Headers }[] = [];
  const f = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    seen.push({ url: input, headers: new Headers(init?.headers) });
    const body = answer(url, init);
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { f, seen };
}

const proofFor = (token: string, challenge: string) =>
  createHmac('sha256', token).update(healthProofMessage(challenge), 'utf8').digest('hex');

describe('verifyDaemon', () => {
  it('verified: the daemon proves it holds the token; the token is never sent', async () => {
    const { f, seen } = fetchAnswering((url) =>
      health(proofFor(TOKEN, url.searchParams.get('challenge') ?? '')),
    );
    expect(await verifyDaemon('http://127.0.0.1:7428', TOKEN, f)).toMatchObject({
      kind: 'verified',
      health: { version: '1.2.3' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toMatch(/\/api\/health\?challenge=[0-9a-f]{64}$/);
    expect(seen[0]?.url).not.toContain(TOKEN);
    expect(seen[0]?.headers.get('authorization')).toBeNull();
  });

  it('something else answers (another daemon, a wrong proof, no proof): other', async () => {
    for (const proof of [undefined, 'a'.repeat(64), proofFor('another-token', 'x')]) {
      const { f } = fetchAnswering(() => health(proof));
      expect((await verifyDaemon('http://127.0.0.1:7428', TOKEN, f)).kind).toBe('other');
    }
  });

  it('nothing answers: unreachable', async () => {
    const { f } = fetchAnswering(() => new TypeError('fetch failed'));
    expect((await verifyDaemon('http://127.0.0.1:7428', TOKEN, f)).kind).toBe('unreachable');
  });
});
