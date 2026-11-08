import type { Output } from './deps.js';

/**
 * SEC-09: characters a terminal may act on, which repository content (directory names, branch
 * names, git messages) must never reach raw: C0 controls (ESC starts escape sequences, CR
 * rewrites the line), DEL, C1 controls (8-bit CSI/OSC), and invisible or bidirectional
 * formatting characters that reorder or hide text (Trojan Source). As code point ranges: C0
 * except tab and newline; DEL and C1; ALM; zero-width chars, LRM, RLM; line/paragraph
 * separators and bidi embeddings/overrides; bidi isolates; BOM.
 */
const UNSAFE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x08],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function hex4(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

function charClass(ranges: ReadonlyArray<readonly [number, number]>): RegExp {
  const body = ranges.map(([a, b]) => (a === b ? hex4(a) : `${hex4(a)}-${hex4(b)}`)).join('');
  return new RegExp(`[${body}]`, 'g');
}

const UNSAFE = charClass(UNSAFE_RANGES);
/** Inside one line, tab and newline (and every other C0 control) are escaped too. */
const UNSAFE_IN_LINE = charClass([[0x00, 0x1f], ...UNSAFE_RANGES.slice(2)]);

/** `\uXXXX`: visible, and still valid inside a JSON string (so `--json` output stays valid). */
function escapeChar(char: string): string {
  return hex4(char.codePointAt(0) ?? 0);
}

/** Escapes unsafe characters in CLI output; keeps `\n` and `\t` (our own formatting). */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE, escapeChar);
}

/** For a repository-derived value inside one line: also escapes `\n`, `\r` and `\t`. */
export function oneLine(value: string): string {
  return value.replace(UNSAFE_IN_LINE, escapeChar);
}

/** Wraps an output stream so nothing unsafe reaches the terminal, whatever its source. */
export function safeOutput(out: Output): Output {
  return { write: (chunk: string) => out.write(terminalSafe(String(chunk))) };
}
