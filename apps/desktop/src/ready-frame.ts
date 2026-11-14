/**
 * The ready line over **stdout** (#22, DECISIONS #612/#613): `wsl.exe` passes only fds 0-2 to the
 * Linux process, so the WSL backend runs `serve --ready-stdout <nonce>` and the line arrives framed
 * in the daemon's ordinary output (`formatServeReadyFrame` in the contracts).
 *
 * `ReadyFrameReader` splits that stdout into what goes to `daemon.log` and the frame:
 *
 * - A frame is a whole line that **starts** with `SERVE_READY_FRAME_PREFIX` (RS + `octopus-diff-ready `).
 *   The prefix in the middle of a line is ordinary output.
 * - Only a frame with **this run's nonce** is the ready line; only the first one counts. Every
 *   frame-like line (ours, a later one, another nonce) is withheld from the log: it may hold a
 *   token. Foreign ones are counted so the supervisor can note them (never their text).
 * - Ordinary output streams to the log as it comes (a partial line is not held), except a line
 *   that could still turn into a frame (it is a prefix of the frame prefix, or starts with it),
 *   which is held until it ends or proves otherwise.
 * - A frame-like line longer than `maxLine` is dropped; when it carries our nonce, `tooLong` is set
 *   (the attempt fails, as for an over-long fd 3 line).
 *
 * Pure (strings in, strings out): the supervisor decodes the bytes (UTF-8, `StringDecoder`).
 */
import { randomBytes } from 'node:crypto';
import { SERVE_READY_FRAME_PREFIX, ServeReadyNonceSchema } from '@octopus-diff/contracts';

/** Same bound as fd 3 (`READY_LINE_MAX_BYTES` in backend.ts): a ready line is ~200 bytes. */
const DEFAULT_MAX_LINE = 16 * 1024;

export interface FrameChunk {
  /** Text for the log (never a frame-like line). */
  output: string;
  /** The JSON of our frame, the first time it is complete; else null. */
  frame: string | null;
  /** Frame-like lines with another nonce (or a second frame), dropped in this chunk. */
  foreign: number;
  /** Our frame was longer than the limit (it is dropped). */
  tooLong: boolean;
}

/** A fresh nonce for one run: 32 URL-safe characters (24 random bytes). */
export function newReadyNonce(): string {
  return randomBytes(24).toString('base64url');
}

export class ReadyFrameReader {
  readonly #head: string;
  readonly #max: number;
  /** The current line, when it is held (a possible frame); '' otherwise. */
  #held = '';
  /** True while the current line is held; false once part of it went to the log. */
  #atLineStart = true;
  /** The current (held) line was already found too long: drop the rest of it. */
  #dropping = false;
  #found = false;

  constructor(nonce: string, maxLine = DEFAULT_MAX_LINE) {
    if (!ServeReadyNonceSchema.safeParse(nonce).success) throw new Error('invalid ready nonce');
    this.#head = `${SERVE_READY_FRAME_PREFIX}${nonce} `;
    this.#max = maxLine;
  }

  push(chunk: string): FrameChunk {
    const out: FrameChunk = { output: '', frame: null, foreign: 0, tooLong: false };
    let rest = chunk;
    while (rest.length > 0) {
      const nl = rest.indexOf('\n');
      const piece = nl === -1 ? rest : rest.slice(0, nl);
      rest = nl === -1 ? '' : rest.slice(nl + 1);
      this.#take(piece, nl !== -1, out);
    }
    return out;
  }

  /** The stream ended: a held line that is not a frame goes to the log; a partial frame does not. */
  end(): string {
    const held = this.#held;
    this.#held = '';
    if (held === '' || this.#frameLike(held) || this.#dropping) return '';
    return held;
  }

  #frameLike(line: string): boolean {
    return line.startsWith(SERVE_READY_FRAME_PREFIX);
  }

  /** Could `text` (the start of a line) still turn into a frame? */
  #mayBecomeFrame(text: string): boolean {
    return SERVE_READY_FRAME_PREFIX.startsWith(text) || this.#frameLike(text);
  }

  #take(piece: string, ended: boolean, out: FrameChunk): void {
    if (!this.#atLineStart) {
      // Part of this line already went to the log: it is ordinary output to its end.
      out.output += ended ? `${piece}\n` : piece;
      if (ended) this.#atLineStart = true;
      return;
    }
    if (this.#dropping) {
      if (ended) {
        this.#dropping = false;
        this.#held = '';
      }
      return;
    }
    const line = this.#held + piece;
    if (!ended) {
      if (!this.#mayBecomeFrame(line)) {
        // Ordinary output: stream it now.
        this.#held = '';
        out.output += line;
        this.#atLineStart = false;
        return;
      }
      if (line.length > this.#max) {
        if (line.startsWith(this.#head) && !this.#found) out.tooLong = true;
        this.#held = '';
        this.#dropping = true;
        return;
      }
      this.#held = line;
      return;
    }
    this.#held = '';
    const text = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!this.#frameLike(text)) {
      out.output += `${line}\n`;
      return;
    }
    if (text.length > this.#max) {
      if (text.startsWith(this.#head) && !this.#found) out.tooLong = true;
      return;
    }
    if (text.startsWith(this.#head) && !this.#found) {
      this.#found = true;
      out.frame = text.slice(this.#head.length);
      return;
    }
    out.foreign += 1;
  }
}
