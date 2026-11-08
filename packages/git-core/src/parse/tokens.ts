/** Splits NUL-terminated output into tokens, dropping the empty token after a final NUL. */
export function splitNul(output: string): string[] {
  if (output.length === 0) return [];
  const tokens = output.split('\u0000');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  return tokens;
}

/**
 * Splits `value` at the first `count` spaces: returns `count` fields plus the remainder (which
 * may itself contain spaces, e.g. a path). Returns null if there are fewer fields.
 */
export function splitFields(
  value: string,
  count: number,
): { fields: string[]; rest: string } | null {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < count; i += 1) {
    const space = value.indexOf(' ', start);
    if (space < 0) return null;
    fields.push(value.slice(start, space));
    start = space + 1;
  }
  return { fields, rest: value.slice(start) };
}

const NULL_OID = /^0+$/;

/** True for the all-zero object id git prints for "no object". */
export function isNullOid(oid: string): boolean {
  return NULL_OID.test(oid);
}
