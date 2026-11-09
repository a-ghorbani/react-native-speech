/**
 * A frozen string-keyed table with no prototype, so a word from the text
 * ("constructor", "toString", "__proto__") misses instead of returning an
 * Object.prototype member.
 */
export function lookupTable<T>(
  entries: Record<string, T>,
): Readonly<Record<string, T>> {
  return Object.freeze(Object.assign(Object.create(null), entries));
}
