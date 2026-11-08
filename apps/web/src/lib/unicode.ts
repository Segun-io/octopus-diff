/**
 * Trojan Source defence (security review SEC-05): bidirectional controls and invisible or
 * zero-width characters in file names and patch text are made visible as `⟨U+202E⟩` escapes and
 * flagged, so what the reviewer reads is what git stores.
 */

/** Bidi controls, zero-width and invisible format characters, BOM, soft hyphen, word joiner. */
const SUSPICIOUS =
  /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD\u180E]/g;

const NAMES: Record<number, string> = {
  1564: 'ARABIC LETTER MARK',
  8203: 'ZERO WIDTH SPACE',
  8204: 'ZERO WIDTH NON-JOINER',
  8205: 'ZERO WIDTH JOINER',
  8206: 'LEFT-TO-RIGHT MARK',
  8207: 'RIGHT-TO-LEFT MARK',
  8234: 'LEFT-TO-RIGHT EMBEDDING',
  8235: 'RIGHT-TO-LEFT EMBEDDING',
  8236: 'POP DIRECTIONAL FORMATTING',
  8237: 'LEFT-TO-RIGHT OVERRIDE',
  8238: 'RIGHT-TO-LEFT OVERRIDE',
  8288: 'WORD JOINER',
  8294: 'LEFT-TO-RIGHT ISOLATE',
  8295: 'RIGHT-TO-LEFT ISOLATE',
  8296: 'FIRST STRONG ISOLATE',
  8297: 'POP DIRECTIONAL ISOLATE',
  65279: 'ZERO WIDTH NO-BREAK SPACE',
  173: 'SOFT HYPHEN',
  6158: 'MONGOLIAN VOWEL SEPARATOR',
};

export interface SuspiciousChar {
  codePoint: number;
  label: string;
  count: number;
}

export function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Distinct suspicious characters in `text` with counts; empty when the text is clean. */
export function findSuspicious(text: string): SuspiciousChar[] {
  const counts = new Map<number, number>();
  // `matchAll` clones the regex with its current lastIndex: always start from 0.
  SUSPICIOUS.lastIndex = 0;
  for (const m of text.matchAll(SUSPICIOUS)) {
    const cp = m[0].codePointAt(0) ?? 0;
    counts.set(cp, (counts.get(cp) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([codePoint, count]) => ({
      codePoint,
      label: `${codePointLabel(codePoint)} ${NAMES[codePoint] ?? ''}`.trim(),
      count,
    }));
}

export function hasSuspicious(text: string): boolean {
  SUSPICIOUS.lastIndex = 0;
  const found = SUSPICIOUS.test(text);
  SUSPICIOUS.lastIndex = 0;
  return found;
}

/** Replaces each suspicious character with a visible `⟨U+XXXX⟩` escape. */
export function escapeSuspicious(text: string): string {
  return text.replace(SUSPICIOUS, (ch) => `⟨${codePointLabel(ch.codePointAt(0) ?? 0)}⟩`);
}

/** One line for banners: "3 invisible or bidirectional characters: U+202E ×2, U+2066". */
export function describeSuspicious(found: SuspiciousChar[]): string {
  const total = found.reduce((n, f) => n + f.count, 0);
  const list = found
    .slice(0, 4)
    .map((f) => `${codePointLabel(f.codePoint)}${f.count > 1 ? ` ×${f.count}` : ''}`)
    .join(', ');
  return `${total} invisible or bidirectional ${total === 1 ? 'character' : 'characters'}: ${list}${
    found.length > 4 ? ', …' : ''
  }`;
}
