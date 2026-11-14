/** #22 review: the real `watchBrokenPipes` over stream doubles (EPIPE ignored and remembered). */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { watchBrokenPipes } from '../src/deps.js';

const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

describe('watchBrokenPipes', () => {
  it('an EPIPE on stdout or stderr is remembered, not thrown', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const pipes = watchBrokenPipes({ stdout, stderr });
    expect([pipes.stdout(), pipes.stderr()]).toEqual([false, false]);
    expect(() => stderr.emit('error', epipe())).not.toThrow();
    expect([pipes.stdout(), pipes.stderr()]).toEqual([false, true]);
    expect(() => stdout.emit('error', epipe())).not.toThrow();
    expect(pipes.stdout()).toBe(true);
    // A write after destroy reports ERR_STREAM_DESTROYED: also a broken pipe.
    expect(() =>
      stderr.emit('error', Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' })),
    ).not.toThrow();
  });

  it('any other error still surfaces', () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    watchBrokenPipes({ stdout, stderr });
    expect(() => stderr.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' }))).toThrow(
      'EIO',
    );
  });
});
