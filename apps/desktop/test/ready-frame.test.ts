/** #22: reading the ready frame from a `wsl.exe` child's stdout, with hostile output around it. */
import { formatServeReadyFrame, SERVE_READY_FRAME_PREFIX } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { newReadyNonce, ReadyFrameReader } from '../src/ready-frame.js';
import { readyLine, TOKEN } from './fakes.js';

const NONCE = 'nonce_for_this_run_0123456789';
const READY = JSON.parse(readyLine());
const FRAME = formatServeReadyFrame(NONCE, READY);

/** Feeds `chunks` and collects everything the reader reports. */
function feed(chunks: readonly string[], nonce = NONCE, max?: number) {
  const reader = new ReadyFrameReader(nonce, max);
  let output = '';
  const frames: string[] = [];
  let foreign = 0;
  let tooLong = false;
  for (const chunk of chunks) {
    const r = reader.push(chunk);
    output += r.output;
    if (r.frame !== null) frames.push(r.frame);
    foreign += r.foreign;
    tooLong ||= r.tooLong;
  }
  output += reader.end();
  return { output, frames, foreign, tooLong };
}

describe('ReadyFrameReader', () => {
  it('finds the frame between banner lines and passes the rest through', () => {
    const r = feed([`\n  octopus-diff 1.2.3 is running\n${FRAME}  more output\n`]);
    expect(r.frames).toEqual([JSON.stringify(READY)]);
    expect(r.output).toBe('\n  octopus-diff 1.2.3 is running\n\n  more output\n');
    expect(r.output).not.toContain(TOKEN);
  });

  it('finds a frame split across chunks at every byte', () => {
    const text = `banner\n${FRAME}after\n`;
    for (let i = 1; i < text.length; i++) {
      const r = feed([text.slice(0, i), text.slice(i)]);
      expect(r.frames, `split at ${i}`).toEqual([JSON.stringify(READY)]);
      expect(r.output, `split at ${i}`).toBe('banner\n\nafter\n');
    }
    const oneByOne = feed([...text]);
    expect(oneByOne.frames).toEqual([JSON.stringify(READY)]);
    expect(oneByOne.output).toBe('banner\n\nafter\n');
  });

  it('a frame with another nonce is not the ready line, and is never passed to the log', () => {
    const forged = formatServeReadyFrame('another_nonce_0123456789', {
      ...READY,
      authUrl: 'http://127.0.0.1:9/#token=forged',
    });
    const r = feed([`x\n${forged}${FRAME}`]);
    expect(r.frames).toEqual([JSON.stringify(READY)]);
    expect(r.foreign).toBe(1);
    expect(r.output).not.toContain('forged');
    expect(r.output).not.toContain(SERVE_READY_FRAME_PREFIX.trim());
  });

  it('the prefix in the middle of a line is ordinary output (a frame starts a line)', () => {
    const line = `echo: ${SERVE_READY_FRAME_PREFIX}${NONCE} ${JSON.stringify(READY)}`;
    const r = feed([`${line}\n`]);
    expect(r.frames).toEqual([]);
    expect(r.output).toBe(`${line}\n`);
  });

  it('only the first frame counts; a later one is dropped, never logged', () => {
    const second = formatServeReadyFrame(NONCE, { ...READY, pid: 99 });
    const r = feed([FRAME, second, 'tail\n']);
    expect(r.frames).toEqual([JSON.stringify(READY)]);
    expect(r.output).toBe('\n\ntail\n');
    expect(r.output).not.toContain(TOKEN);
  });

  it('accepts CRLF line ends', () => {
    const r = feed([FRAME.replace(/\n$/, '\r\n')]);
    expect(r.frames).toEqual([JSON.stringify(READY)]);
  });

  it('a frame line longer than the limit is reported (too long) and dropped', () => {
    const huge = `\n${SERVE_READY_FRAME_PREFIX}${NONCE} ${'x'.repeat(300)}`;
    const r = feed([huge], NONCE, 200);
    expect(r.tooLong).toBe(true);
    expect(r.frames).toEqual([]);
    expect(r.output).not.toContain('xxxx');
  });

  it('a whole over-long frame line in one chunk is reported too (and dropped)', () => {
    const huge = `\n${SERVE_READY_FRAME_PREFIX}${NONCE} ${'x'.repeat(300)}\nafter\n`;
    const r = feed([huge], NONCE, 200);
    expect(r.tooLong).toBe(true);
    expect(r.frames).toEqual([]);
    expect(r.output).toBe('\nafter\n');
    // Another run's over-long frame is dropped without failing this one.
    const other = feed(
      [`\n${SERVE_READY_FRAME_PREFIX}other_nonce_0123456789 ${'x'.repeat(300)}\n`],
      NONCE,
      200,
    );
    expect(other.tooLong).toBe(false);
    expect(other.output).toBe('\n');
  });

  it('streams ordinary partial lines without waiting for a newline, and long ones too', () => {
    const reader = new ReadyFrameReader(NONCE, 64);
    expect(reader.push('partial ').output).toBe('partial ');
    expect(reader.push('line').output).toBe('line');
    expect(reader.push(`${'y'.repeat(100)}\n`).output).toBe(`${'y'.repeat(100)}\n`);
  });

  it('holds a line that could still become a frame, and releases it when it does not', () => {
    const reader = new ReadyFrameReader(NONCE);
    expect(reader.push('\u001eocto').output).toBe('');
    expect(reader.push('pus is not a frame\n').output).toBe('\u001eoctopus is not a frame\n');
  });

  it('an unterminated frame at the end of the stream is not logged', () => {
    const r = feed([`ok\n${SERVE_READY_FRAME_PREFIX}${NONCE} {"mode":"started"`]);
    expect(r.frames).toEqual([]);
    expect(r.output).toBe('ok\n');
  });

  it('control bytes and NULs around it do not confuse it', () => {
    const r = feed([`\u0000\u001b[2J\u001e\n${FRAME}\u0000\n`]);
    expect(r.frames).toEqual([JSON.stringify(READY)]);
    expect(r.output).toBe('\u0000\u001b[2J\u001e\n\n\u0000\n');
  });

  it('refuses a nonce that is not a valid one', () => {
    expect(() => new ReadyFrameReader('short')).toThrow();
    expect(() => new ReadyFrameReader(`${'a'.repeat(16)} `)).toThrow();
  });
});

describe('newReadyNonce', () => {
  it('is a valid, fresh nonce each time', () => {
    const a = newReadyNonce();
    const b = newReadyNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,128}$/);
    expect(a).not.toBe(b);
  });
});
