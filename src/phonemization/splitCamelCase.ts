/**
 * splitCamelCase — insert spaces at camelCase / PascalCase boundaries
 * so each part can be looked up independently by the phonemizer.
 *
 * Two conservative rules, both required to avoid mangling normal English:
 *
 *   A. UPPER-run + Capital + lower         e.g. "XMLParser" → "XML Parser"
 *      Pattern: /([A-Z]{2,})([A-Z][a-z])/g
 *
 *   B. lower + UPPER-run that runs to a non-letter / end-of-word
 *      e.g. "prismML" → "prism ML", "iOS's" → "i OS's"
 *      Pattern: /([a-z])([A-Z]+)(?=[^A-Za-z]|$)/g
 *
 * Words that should NOT split (verified empirically against hans00 + espeak-ng):
 *   iPhone, iCloud, McDonald, MacBook, MyClass, JavaScript, GitHub, USA, HTTP,
 *   I'm, OK, JSDoc-style without trailing all-caps run, etc.
 *
 * Mirrors the spirit of espeak-ng's translate.c case-transition handling.
 */

const RE_RULE_A = /([A-Z]{2,})([A-Z][a-z])/g;
const RE_RULE_B = /([a-z])([A-Z]+)(?=[^A-Za-z]|$)/g;

export function splitCamelCase(text: string): string {
  // Fast path: skip if there's no mixed-case ASCII to act on.
  if (!/[a-z]/.test(text) || !/[A-Z]/.test(text)) return text;
  let s = text.replace(RE_RULE_A, '$1 $2');
  s = s.replace(RE_RULE_B, '$1 $2');
  return s;
}
