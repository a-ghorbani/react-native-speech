import {contextWords, heteronymForm} from '../heteronyms';
import {splitOnPunctuation} from '../../engines/kokoro/Phonemizer';

/** Form chosen for the first <<marked>> word, or 'dict' when none applies. */
function pick(marked: string): string {
  const m = /<<(\w+)>>/.exec(marked)!;
  const text = marked.replace(/<<|>>/g, '');
  const words = contextWords(splitOnPunctuation(text));
  const i = contextWords(splitOnPunctuation(marked.slice(0, m.index))).length;
  return heteronymForm(words, i) ?? 'dict';
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
    ['We just <<use>> caches', 'jˈuːz'],
    ['It <<records>> everything', 'ɹᵻkˈɔːɹdz'],
    ['Where they <<live>>.', 'lˈɪv'],
    ['A full <<import>>.', 'ˈɪmpˌɔːɹt'],
    ['The tests <<import>> helpers', 'dict'],
    ['<<Read>> the last line', 'dict'],
    // Review r1: general assistant text keeps the dict form
    ['<<Use>> cases include chatbots', 'dict'],
    ['<<Use>> case: offline notes', 'dict'],
    ['<<Use>>: the verb', 'dict'],
    ['Common <<uses>> of Python include', 'dict'],
    ['Other <<uses>> are listed below', 'dict'],
    ['Typical <<uses>> include logging', 'dict'],
    ['<<Rerun>> npm install', 'dict'],
    ['Then <<rerun>> npm test', 'dict'],
    ['Just <<rerun>>.', 'dict'],
    ['Navigate to <<project>> settings', 'dict'],
    ['Switch to <<record>> mode', 'dict'],
    ['The result is close to <<perfect>>', 'dict'],
    ['Set the type to <<object>>', 'dict'],
    ['You need to <<use>> caches', 'jˈuːz'],
    ['How to <<record>> a macro', 'ɹᵻkˈɔːɹd'],
    ['The feature is currently <<live>> in production', 'dict'],
    ['Your app is already <<live>> in the store', 'dict'],
    ["We're <<live>> on Twitch", 'dict'],
    ['Methods currently <<live>> in utils', 'lˈɪv'],
    ['<<Read>> the logs from yesterday', 'dict'],
    ['You can <<read>> the report from yesterday', 'dict'],
    ['We made good <<progress>> this week', 'dict'],
    ['Make some <<progress>> each day', 'dict'],
    ['There were two <<conflicts>> this week', 'dict'],
    ['Show all <<records>> this month', 'dict'],
    ['Which methods should a subclass <<override>>?', 'dict'],
    ['Check the files your scripts <<import>>.', 'dict'],
    ['Real-world <<uses>> include logging', 'dict'],
    ['Common <<uses>> in finance', 'dict'],
    ['Did you <<read>> it yesterday?', 'dict'],
    ['I <<read>> it yesterday and liked it', 'ɹˈɛd'],
    ['I <<read>> it last week', 'ɹˈɛd'],
    ['They <<read>> the last section aloud', 'dict'],
    ['The new <<import>> works', 'ˈɪmpˌɔːɹt'],
    ['The CI <<rerun>> passed', 'ɹˈiːɹˌʌn'],
    ["It can't be <<rerun>> yet", 'dict'],
    ['CI <<reruns>> now', 'dict'],
    ['The script <<uses>> bash', 'jˈuːzᵻz'],
    ['The <<uses>> of it', 'dict'],
    ['<<Use>> the cache', 'jˈuːz'],
    ['<<Use>> shutdownNow instead', 'jˈuːz'],
    ['<<Use>> of caches is fine', 'dict'],
    ['You can watch it <<live>> with this', 'dict'],
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
    // "we" is in another clause, so no verb cue reaches "record".
    expect(pick('We, <<record>>.')).toBe('dict');
    expect(pick('We <<record>>.')).toBe('ɹᵻkˈɔːɹd');
  });
});
