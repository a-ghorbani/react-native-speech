/**
 * Heteronyms: words whose reading depends on part of speech ("we use it"
 * vs "the use of"). The dict holds one form per word; this table holds the
 * other one, picked from the neighbouring words. With no clear cue the
 * dict form stays.
 *
 * Forms are from misaki's POS-keyed gold dictionary (us_gold.json,
 * https://github.com/hexgrad/misaki, Apache-2.0), converted to this
 * dict's IPA notation. See docs/LICENSES.md.
 */

type Form = {
  verb?: string;
  noun?: string;
  past?: string;
  /** Reading with no cue, when it isn't the dict's ("the script uses X"). */
  usual?: 'verb' | 'noun';
};

const TABLE: Record<string, Form> = {
  read: {past: 'ɹˈɛd'},
  use: {verb: 'jˈuːz'},
  uses: {verb: 'jˈuːzᵻz', usual: 'verb'},
  live: {verb: 'lˈɪv'},
  lives: {verb: 'lˈɪvz'},
  close: {verb: 'klˈoʊz'},
  record: {verb: 'ɹᵻkˈɔːɹd'},
  records: {verb: 'ɹᵻkˈɔːɹdz'},
  house: {verb: 'hˈaʊz'},
  separate: {verb: 'sˈɛpɚɹˌeɪt'},
  estimate: {verb: 'ˈɛstᵻmˌeɪt'},
  approximate: {verb: 'ɐpɹˈɑːksɪmˌeɪt'},
  duplicate: {noun: 'dˈuːplᵻkət'},
  duplicates: {noun: 'dˈuːplᵻkəts'},
  document: {verb: 'dˈɑːkjuːmˌɛnt'},
  documents: {verb: 'dˈɑːkjuːmˌɛnts'},
  implement: {verb: 'ˈɪmplɪmˌɛnt'},
  // Stress shift: noun on the first syllable, verb on the second.
  progress: {verb: 'pɹəɡɹˈɛs'},
  conflict: {verb: 'kənflˈɪkt'},
  conflicts: {verb: 'kənflˈɪkts'},
  contract: {verb: 'kəntɹˈækt'},
  project: {verb: 'pɹədʒˈɛkt'},
  projects: {verb: 'pɹədʒˈɛkts'},
  present: {verb: 'pɹᵻzˈɛnt'},
  presents: {verb: 'pɹᵻzˈɛnts'},
  object: {verb: 'əbdʒˈɛkt'},
  objects: {verb: 'əbdʒˈɛkts'},
  subject: {verb: 'səbdʒˈɛkt'},
  suspect: {verb: 'səspˈɛkt'},
  compound: {verb: 'kəmpˈaʊnd'},
  conduct: {verb: 'kəndˈʌkt'},
  permit: {verb: 'pɚmˈɪt'},
  perfect: {verb: 'pɚfˈɛkt'},
  insert: {verb: 'ɪnsˈɜːt'},
  increase: {verb: 'ɪŋkɹˈiːs'},
  replay: {verb: 'ɹiːplˈeɪ'},
  replays: {verb: 'ɹiːplˈeɪz'},
  rerun: {noun: 'ɹˈiːɹˌʌn', usual: 'noun'},
  reruns: {noun: 'ɹˈiːɹˌʌnz'},
  restart: {noun: 'ɹˈiːstˌɑːɹt'},
  restarts: {noun: 'ɹˈiːstˌɑːɹts'},
  rewrite: {noun: 'ɹˈiːɹˌaɪt'},
  rewrites: {noun: 'ɹˈiːɹˌaɪts'},
  retest: {noun: 'ɹˈiːtˌɛst'},
  refresh: {noun: 'ɹˈiːfɹˌɛʃ'},
  refund: {noun: 'ɹˈiːfˌʌnd'},
  reject: {noun: 'ɹˈiːdʒˌɛkt'},
  rejects: {noun: 'ɹˈiːdʒˌɛkts'},
  reuse: {noun: 'ɹiːjˈuːs'},
  import: {noun: 'ˈɪmpˌɔːɹt'},
  imports: {noun: 'ˈɪmpˌɔːɹts'},
  override: {noun: 'ˈoʊvɚɹˌaɪd'},
  overrides: {noun: 'ˈoʊvɚɹˌaɪdz'},
  overlap: {noun: 'ˈoʊvɚlˌæp'},
  produce: {noun: 'pɹˈoʊdˌuːs'},
  convert: {noun: 'kˈɑːnvˌɜːt'},
  converts: {noun: 'kˈɑːnvˌɜːts'},
};

const set = (s: string) => new Set(s.split(' '));

const ADVERBS = set(
  'also just then now only still always never really not simply actually even usually often first automatically manually quickly easily',
);
const VERB_BEFORE = set(
  "to can could will would shall should may might must do does did don't doesn't didn't won't can't cannot couldn't wouldn't shouldn't i we you they i'll we'll you'll they'll let's please",
);
const BUTTON_BEFORE = set('press click tap hit select choose');
const PASSIVE_BEFORE = set('be been being is are was were get gets got');
const SUBJECT_3SG = set('he she it this that');
const DETERMINERS = set(
  'a an the this these those my your his her its our their no every another whose',
);
const PREPOSITIONS = set(
  'of for in on with from by at into about per without after before during',
);
const QUANTIFIERS = set(
  'all both some each any many few several more most one two three four five six seven eight nine ten',
);
const OBJECT_START = set(
  'the a an it them this these those my your our their his her its me us him all both each every some any',
);
const READ_PAST_BEFORE = set(
  "have has had i've we've you've they've having was were been being is are be already",
);
const READ_ATTRIBUTE_AFTER = set(
  'access only permission permissions write and or receipt receipts replica replicas path paths timeout side model',
);
const LIVE_ADJ_BEFORE = set(
  "is are was were be been being isn't aren't wasn't weren't it's go goes going went gone stay stays stayed staying remain remains remained keep keeps make makes made",
);
const LIVE_PLACE_AFTER = set(
  'in on at under inside here there behind alongside outside within near',
);
const LIVE_SUBJECTS = set('i we you they who');

function isInflected(word: string): boolean {
  return word.endsWith('s') && TABLE[word.slice(0, -1)] !== undefined;
}

/** True when the word is in the table (lowercase, letters only). */
export function isHeteronym(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE, word);
}

/**
 * The context form of `words[i]`, or null to keep the dict form.
 * `words` is the lowercased text with null at clause boundaries; `raw` is
 * the word as written.
 */
export function heteronymForm(
  words: readonly (string | null)[],
  i: number,
  raw: string,
): string | null {
  const word = words[i];
  if (!word || !isHeteronym(word)) return null;
  const form = TABLE[word]!;
  const at = (k: number) => (k >= 0 && k < words.length ? words[k] : null);
  const next = at(i + 1);
  const prevRaw = at(i - 1);
  let back = i - 1;
  if (prevRaw && ADVERBS.has(prevRaw)) back--;
  const prev = at(back);
  const prev2 = at(back - 1);

  if (word === 'read') {
    if (next && READ_ATTRIBUTE_AFTER.has(next)) return null;
    if (
      (prevRaw && READ_PAST_BEFORE.has(prevRaw)) ||
      (prev && READ_PAST_BEFORE.has(prev))
    ) {
      return form.past!;
    }
    for (let k = i + 1; k <= i + 4 && at(k); k++) {
      const w = at(k)!;
      const after = at(k + 1);
      if (w === 'yesterday' || w === 'ago') return form.past!;
      if (
        w === 'last' &&
        after &&
        /^(night|week|time|month|year)$/.test(after)
      ) {
        return form.past!;
      }
    }
    return null;
  }

  if (word === 'live' || word === 'lives') {
    if (prev && LIVE_ADJ_BEFORE.has(prev)) return null;
    if (
      (next && LIVE_PLACE_AFTER.has(next)) ||
      (prev && LIVE_SUBJECTS.has(prev))
    ) {
      return form.verb!;
    }
    return null;
  }

  let pos: 'verb' | 'noun' | null = null;
  // A capitalized word inside a clause is usually a name or a label
  // ("Go to Project settings"); only a button verb before it counts.
  const name = /^[A-Z]/.test(raw) && prevRaw !== null;
  const inflected = isInflected(word);
  if (prev && BUTTON_BEFORE.has(prev)) pos = 'verb';
  else if (form.usual === 'noun' && prev && PASSIVE_BEFORE.has(prev)) {
    pos = 'verb'; // "can't be rerun"
  } else if (name) pos = null;
  else if (
    prev &&
    (inflected ? SUBJECT_3SG.has(prev) : VERB_BEFORE.has(prev))
  ) {
    pos = 'verb';
  } else if (prev && (DETERMINERS.has(prev) || PREPOSITIONS.has(prev))) {
    pos = 'noun';
  } else if (prev && QUANTIFIERS.has(prev)) {
    pos = next && OBJECT_START.has(next) ? 'verb' : 'noun';
  } else if (
    !inflected &&
    prev2 &&
    DETERMINERS.has(prev2) &&
    (!next || PREPOSITIONS.has(next))
  ) {
    // "a full rerun", "the latest import of"
    pos = 'noun';
  } else if (next && OBJECT_START.has(next)) {
    pos = 'verb';
  } else if (word === 'use' && prevRaw === null) {
    // Clause-initial "Use X" is an instruction; "Use of X" took the
    // preposition branch above only if something preceded it.
    pos = next && PREPOSITIONS.has(next) ? 'noun' : 'verb';
  } else if (form.usual) {
    pos = form.usual;
  }
  return pos ? (form[pos] ?? null) : null;
}

/**
 * The lowercased words of `chunks` with null at each clause boundary.
 * Quote-only punctuation is not a boundary ('Click "Record"').
 */
export function contextWords(
  chunks: readonly {isPunctuation: boolean; text: string}[],
): (string | null)[] {
  const out: (string | null)[] = [];
  for (const c of chunks) {
    if (c.isPunctuation) {
      if (!/^[\s"'“”‘’«»]*$/.test(c.text)) out.push(null);
    } else if (c.text.trim()) {
      for (const w of c.text.trim().split(/\s+/)) {
        out.push(w.toLowerCase().replace(/[^a-z']/g, ''));
      }
    }
  }
  return out;
}
