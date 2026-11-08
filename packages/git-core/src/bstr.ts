/**
 * "Binary strings" (bstr): raw bytes held 1:1 in a JS string via the latin1 encoding.
 *
 * Git output is parsed in this form so that paths which are not valid UTF-8 survive parsing
 * unchanged. Convert to real (UTF-8) strings only at the edges, with `decodeRepoPath` or
 * `bstrToUtf8`.
 */

const utf8Fatal = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const utf8Lossy = new TextDecoder('utf-8', { ignoreBOM: true });
const NON_ASCII = /[\u0080-\uffff]/;
const ASCII_ONLY = { test: (value: string): boolean => !NON_ASCII.test(value) };

export function bstrFromBuffer(buffer: Buffer): string {
  return buffer.toString('latin1');
}

export function bstrToBuffer(value: string): Buffer {
  return Buffer.from(value, 'latin1');
}

/** Encodes a real string as UTF-8 bytes and returns them as a bstr. */
export function bstrFromUtf8(value: string): string {
  return ASCII_ONLY.test(value) ? value : Buffer.from(value, 'utf8').toString('latin1');
}

/** Decodes a bstr as UTF-8, replacing invalid sequences with U+FFFD. */
export function bstrToUtf8(value: string): string {
  return ASCII_ONLY.test(value) ? value : utf8Lossy.decode(bstrToBuffer(value));
}

/** True if the bstr holds valid UTF-8. */
export function isValidUtf8(value: string): boolean {
  if (ASCII_ONLY.test(value)) return true;
  try {
    utf8Fatal.decode(bstrToBuffer(value));
    return true;
  } catch {
    return false;
  }
}

export interface DecodedPath {
  /** UTF-8 display path (lossy, with U+FFFD, when `rawPath` is present). */
  path: string;
  /** Base64 of the raw bytes, only when they are not valid UTF-8. */
  rawPath?: string;
}

/** Converts a repo-relative path from git output (bstr) to the contract's `path` / `rawPath`. */
export function decodeRepoPath(value: string): DecodedPath {
  if (ASCII_ONLY.test(value)) return { path: value };
  const buffer = bstrToBuffer(value);
  try {
    return { path: utf8Fatal.decode(buffer) };
  } catch {
    return { path: utf8Lossy.decode(buffer), rawPath: buffer.toString('base64') };
  }
}

/** The bstr key of a file selector: raw bytes from `rawPath` if present, else UTF-8 of `path`. */
export function selectorToBstr(selector: { path: string; rawPath?: string | undefined }): string {
  if (selector.rawPath !== undefined) {
    return Buffer.from(selector.rawPath, 'base64').toString('latin1');
  }
  return bstrFromUtf8(selector.path);
}

/** Byte-wise comparison of two bstrs (git's path order). */
export function compareBstr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
