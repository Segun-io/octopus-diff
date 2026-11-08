/** CSS attribute-value escaping for `[attr="..."]`. */
export function cssValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
