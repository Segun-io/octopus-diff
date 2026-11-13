import { describe, expect, it } from 'vitest';
import { ServeReadySchema } from '../src/index.js';

const valid = {
  mode: 'started',
  url: 'http://127.0.0.1:7428',
  authUrl: 'http://127.0.0.1:7428/#token=abc',
  pid: 4242,
  version: '0.1.0',
};

describe('ServeReadySchema', () => {
  it('accepts a started and an attached line', () => {
    expect(ServeReadySchema.parse(valid)).toEqual(valid);
    expect(ServeReadySchema.parse({ ...valid, mode: 'attached' }).mode).toBe('attached');
  });

  it('survives a JSON round trip', () => {
    expect(ServeReadySchema.parse(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it('rejects an unknown mode, missing fields and bad values', () => {
    expect(ServeReadySchema.safeParse({ ...valid, mode: 'running' }).success).toBe(false);
    for (const key of ['mode', 'url', 'authUrl', 'pid', 'version']) {
      const { [key]: _omitted, ...rest } = valid as Record<string, unknown>;
      expect(ServeReadySchema.safeParse(rest).success, `without ${key}`).toBe(false);
    }
    expect(ServeReadySchema.safeParse({ ...valid, url: 'not a url' }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...valid, authUrl: '/#token=abc' }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...valid, pid: 0 }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...valid, pid: 1.5 }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...valid, pid: '42' }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...valid, version: '' }).success).toBe(false);
  });
});
