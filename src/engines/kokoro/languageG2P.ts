/**
 * Optional per-language G2P for Kokoro, registered by opt-in entry points
 * (e.g. `@pocketpalai/react-native-speech/zh`) so apps that don't use the
 * language don't bundle its dependencies.
 *
 * A G2P turns text into Kokoro phonemes; `phonemizeOther` handles runs in
 * other scripts (Latin words) with the built-in English phonemizer.
 */
export type KokoroLanguageG2P = (
  text: string,
  phonemizeOther: (text: string) => Promise<string>,
) => Promise<string>;

const registry = new Map<string, KokoroLanguageG2P>();

export function registerKokoroG2P(
  language: string,
  g2p: KokoroLanguageG2P,
): void {
  registry.set(language, g2p);
}

export function getKokoroG2P(language: string): KokoroLanguageG2P | undefined {
  return registry.get(language);
}
