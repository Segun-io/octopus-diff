import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/index.js';

describe('daemon placeholder', () => {
  it('exports startDaemon', async () => {
    await expect(startDaemon()).rejects.toThrow(/placeholder/);
  });
});
