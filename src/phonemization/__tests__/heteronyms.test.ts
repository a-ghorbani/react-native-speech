import {contextWords, heteronymForm} from '../heteronyms';
import {splitOnPunctuation} from '../../engines/kokoro/Phonemizer';

/** Form chosen for the first <<marked>> word, or 'dict' when none applies. */
function pick(marked: string): string {
  const m = /<<(\w+)>>/.exec(marked)!;
  const text = marked.replace(/<<|>>/g, '');
  const words = contextWords(splitOnPunctuation(text));
  const i = contextWords(splitOnPunctuation(marked.slice(0, m.index))).length;
  return heteronymForm(words, i, m[1]!) ?? 'dict';
}

describe('heteronymForm (#31)', () => {
  test.each([
    // The issue's rows
    ['We <<use>> it', 'jˈuːz'],
    ['<<Close>> the door', 'klˈoʊz'],
    ['They <<live>> here', 'lˈɪv'],
    ['I <<read>> it yesterday', 'ɹˈɛd'],
    ['Press <<record>>', 'ɹᵻkˈɔːɹd'],
    // Verb cues
    ['You can <<use>> the cache', 'jˈuːz'],
    ['It also <<uses>> a cache', 'jˈuːzᵻz'],
    ['The app <<uses>> a cache', 'jˈuːzᵻz'],
    ['Click "<<Record>>" to start', 'ɹᵻkˈɔːɹd'],
    ['They all <<import>> the same helper', 'dict'],
    ['Files <<live>> in src', 'lˈɪv'],
    ['I have <<read>> the brief', 'ɹˈɛd'],
    ['It was <<read>> twice', 'ɹˈɛd'],
    ['We <<rerun>> the job', 'dict'],
    // Noun cues
    ['A full <<rerun>>.', 'ɹˈiːɹˌʌn'],
    ['The <<rerun>> passed', 'ɹˈiːɹˌʌn'],
    ['Three <<reruns>> passed', 'ɹˈiːɹˌʌnz'],
    ['After the <<import>> of data', 'ˈɪmpˌɔːɹt'],
    ['Add the <<override>>', 'ˈoʊvɚɹˌaɪd'],
    ['The <<use>> of caches', 'dict'],
    ['A <<record>> of it', 'dict'],
    // Keeps the dict form (adversarial)
    ['The function <<overrides>> the default', 'dict'],
    ['The module <<imports>> React', 'dict'],
    ['The server <<rejects>> the request', 'dict'],
    ['A <<close>> match', 'dict'],
    ['In <<close>> proximity', 'dict'],
    ['It is <<close>> to done', 'dict'],
    ['<<Read>> the last 20 lines', 'dict'],
    ['You can <<read>> the last section', 'dict'],
    ['The token has <<read>> access', 'dict'],
    ['Make it <<read>>-only', 'dict'],
    ['I <<read>> your code', 'dict'],
    ['Go to <<Project>> settings', 'dict'],
    ['Switch to <<live>> mode', 'dict'],
    ['It went <<live>> on Tuesday', 'dict'],
    ['The data is <<live>> in prod', 'dict'],
    ['Files that <<use>> it', 'jˈuːz'],
    ['That <<use>> case', 'dict'],
    ['Which <<records>> changed', 'dict'],
    ['A <<separate>> file', 'dict'],
  ])('%s → %s', (text, expected) => {
    expect(pick(text)).toBe(expected);
  });

  test('a clause boundary cuts the context', () => {
    // "we" is in another clause, so no verb cue reaches "rerun".
    expect(pick('As we said, <<rerun>>.')).toBe('dict');
  });
});
