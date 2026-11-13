/**
 * `daemon.log` in Electron's logs dir: the daemon's stdout/stderr and the supervisor's own lines
 * (`[desktop] …`). One previous file is kept (`daemon.log.1`) when it grew past `MAX_LOG_BYTES`.
 * Nothing written here contains the token: the ready line is parsed, never copied.
 *
 * The file is opened once in append mode and its descriptor is given to the daemon as stdout and
 * stderr (`fd`), so the daemon writes there itself: when Electron crashes or is killed, the
 * daemon's writes still succeed and its stdin-EOF shutdown runs to the end (a broken stdout pipe
 * made the CLI exit 1 halfway, leaving `daemon.json` behind; DECISIONS #490). The supervisor's
 * notes are small synchronous appends to the same descriptor (O_APPEND: no interleaving inside a
 * line).
 */
import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import type { BackendLog } from './backend.js';

export const LOG_FILE = 'daemon.log';
export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface LogFile extends BackendLog {
  readonly path: string;
  /** The open descriptor (append mode) for the daemon's stdout/stderr, or null if unavailable. */
  readonly fd: number | null;
  close(): void;
}

/** Moves a big log aside (`.1`) so each file stays small; errors are ignored (logging is best effort). */
export function rotateIfLarge(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

export function formatNote(line: string, now: Date): string {
  return `[desktop ${now.toISOString()}] ${line}\n`;
}

export function openLogFile(dir: string, now: () => Date = () => new Date()): LogFile {
  const file = path.join(dir, LOG_FILE);
  let fd: number | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    rotateIfLarge(file);
    fd = openSync(file, 'a', 0o600);
  } catch {
    fd = null;
  }
  const write = (data: string | Buffer) => {
    if (fd === null) return;
    try {
      if (typeof data === 'string') writeSync(fd, data);
      else writeSync(fd, data);
    } catch {
      // Best effort: a full disk must not take the app down.
    }
  };
  return {
    path: file,
    get fd() {
      return fd;
    },
    output: (chunk) => write(chunk),
    note: (line) => write(formatNote(line, now())),
    close() {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = null;
    },
  };
}

/** A log that writes nothing (a second instance, which exits right away). */
export function noLogFile(): LogFile {
  return {
    path: '',
    fd: null,
    output: () => undefined,
    note: () => undefined,
    close: () => undefined,
  };
}
