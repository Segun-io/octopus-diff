import { DESKTOP_CLI_CHANNELS } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { CLI_CHANNELS } from '../src/ipc-channels.js';

describe('the preload copy of the command installer channels', () => {
  it('equals the contract DESKTOP_CLI_CHANNELS', () => {
    expect(CLI_CHANNELS).toEqual(DESKTOP_CLI_CHANNELS);
  });
});
