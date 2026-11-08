/**
 * Parses `git for-each-ref --format=<f1>%00<f2>%00...` output: one ref per LF-terminated line
 * (ref names cannot contain LF or NUL), fields separated by NUL. Lines with a different field
 * count are skipped.
 */
export function parseForEachRef(output: string, fieldCount: number): string[][] {
  const rows: string[][] = [];
  for (const line of output.split('\n')) {
    if (line.length === 0) continue;
    const fields = line.split('\u0000');
    if (fields.length !== fieldCount) continue;
    rows.push(fields);
  }
  return rows;
}

/** Format string for `parseForEachRef`: `%(a)%00%(b)...`. */
export function forEachRefFormat(atoms: readonly string[]): string {
  return atoms.map((atom) => `%(${atom})`).join('%00');
}
