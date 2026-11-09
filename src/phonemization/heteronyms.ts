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
  'also just then now only still always never really not simply actually even usually often first automatically manually quickly easily already ever',
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
const READ_PRESENT_BEFORE = set(
  "to can could will would shall should may might must do does did don't doesn't didn't won't can't cannot couldn't wouldn't shouldn't let's please",
);
const READ_PAST_BEFORE = set(
  "have has had i've we've you've they've having was were been being is are be already",
);
const READ_ATTRIBUTE_AFTER = set(
  'access only permission permissions write and or receipt receipts replica replicas path paths timeout side model',
);
const LIVE_ADJ_BEFORE = set(
  "is are was were be been being isn't aren't wasn't weren't it's that's there's i'm we're you're they're he's she's go goes going went gone stay stays stayed staying remain remains remained keep keeps make makes made watch watched watching stream streamed streaming broadcast air airs aired",
);
const LIVE_PLACE_AFTER = set(
  'in on at under inside here there behind alongside outside within near',
);
const LIVE_SUBJECTS = set('i we you they who');
// "live stream", "live demo": the adjective before a noun.
const LIVE_NOUN_AFTER = set(
  'stream streams streaming streamed demo demos event events preview reload',
);
const SUBJECTS = set('i we you they he she it');
// "give you", "show you": "you" is the object, not the subject.
const GIVE_VERBS = set(
  'give gives show shows send sends offer offers tell tells bring brings get gets teach teaches buy buys hand hands owe wish',
);
// Plural subjects without an -s ("the people produce").
const PLURAL_NOUNS = set(
  'people children men women media police staff team family government data',
);
// "save lives in": the noun after a verb that takes lives as its object.
const LIVES_OBJECT_VERBS = set(
  'save change risk protect touch improve transform affect lose cost claim',
);
const TIME_NOUNS = set(
  'week weekend day days month year time morning afternoon evening night sprint quarter',
);
// After an -s form these make it a noun ("other uses are", "uses of").
const NOUN_AFTER_S = set('of are were include includes included');
const NOUN_ADJECTIVES = set(
  'common other typical main possible practical potential primary everyday different various',
);
const NOUN_AFTER_USE = set('case cases');

function isInflected(word: string): boolean {
  return word.endsWith('s') && TABLE[word.slice(0, -1)] !== undefined;
}

/** True when the word is in the table (lowercase, letters only). */
export function isHeteronym(word: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE, word);
}

/**
 * The context form of `words[i]`, or null to keep the dict form.
 * `words` is the lowercased text with null at clause boundaries.
 */
export function heteronymForm(
  words: readonly (string | null)[],
  i: number,
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
    // An instruction or a modal is present tense whatever follows
    // ("Read the logs from yesterday", "you can read …").
    if (
      !prev ||
      READ_PRESENT_BEFORE.has(prev) ||
      // "Did you read …?", "Can we read …?"
      (SUBJECTS.has(prev) && !!prev2 && READ_PRESENT_BEFORE.has(prev2))
    ) {
      return null;
    }
    if (
      (prevRaw && READ_PAST_BEFORE.has(prevRaw)) ||
      (prev && READ_PAST_BEFORE.has(prev)) ||
      // "Have you read …?"
      (SUBJECTS.has(prev) && /^(have|has|had)$/.test(prev2 ?? ''))
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
    // Skip "currently", "fully", "already" back to the copula.
    let b = i - 1;
    while (at(b) && (/ly$/.test(at(b)!) || at(b) === 'already')) b--;
    const before = at(b);
    if (!before || LIVE_ADJ_BEFORE.has(before)) return null;
    if (next && LIVE_NOUN_AFTER.has(next)) return null;
    if (before === 'you' && GIVE_VERBS.has(at(b - 1) ?? '')) return null;
    // The verb needs a subject right before it: "they live", "files live
    // in"; not "stream it live on", "watch the game live on".
    const subject =
      LIVE_SUBJECTS.has(before) ||
      (word === 'live'
        ? /[^s]s$/.test(before) || PLURAL_NOUNS.has(before)
        : !DETERMINERS.has(before) &&
          !LIVES_OBJECT_VERBS.has(before) &&
          !/(s|ed)$/.test(before));
    if (
      subject &&
      (LIVE_SUBJECTS.has(before) || (next && LIVE_PLACE_AFTER.has(next)))
    ) {
      return form.verb!;
    }
    return null;
  }

  let pos: 'verb' | 'noun' | null = null;
  const inflected = isInflected(word);
  // "this week", "each day" after the word is a time phrase, not an object.
  const object =
    !!next && OBJECT_START.has(next) && !TIME_NOUNS.has(at(i + 2) ?? '');
  // "to" is a preposition before a noun ("switch to record mode"): it marks
  // the verb only with an object or a preposition after (use: always).
  const toVerb =
    prev !== 'to' ||
    (word === 'use' && !NOUN_AFTER_USE.has(next ?? '')) ||
    object ||
    (!!next && PREPOSITIONS.has(next));
  if (!toVerb) return null; // "switch to record mode", "to rerun npm"
  // "give you use cases": "you" is the object.
  const youObject = prev === 'you' && GIVE_VERBS.has(prev2 ?? '');
  if (prev && BUTTON_BEFORE.has(prev)) pos = 'verb';
  else if (form.usual === 'noun' && prev && PASSIVE_BEFORE.has(prev)) {
    pos = 'verb'; // "can't be rerun"
  } else if (
    prev &&
    !youObject &&
    (inflected ? SUBJECT_3SG.has(prev) : VERB_BEFORE.has(prev))
  ) {
    pos = 'verb';
  } else if (
    prev &&
    (DETERMINERS.has(prev) ||
      PREPOSITIONS.has(prev) ||
      NOUN_ADJECTIVES.has(prev))
  ) {
    pos = 'noun';
  } else if (prev && QUANTIFIERS.has(prev)) {
    pos = object ? 'verb' : 'noun';
  } else if (inflected && next && NOUN_AFTER_S.has(next)) {
    pos = 'noun';
  } else if (
    !inflected &&
    prev2 &&
    DETERMINERS.has(prev2) &&
    !prev!.endsWith('s') &&
    !PLURAL_NOUNS.has(prev!) &&
    (!next || PREPOSITIONS.has(next))
  ) {
    // "a full rerun.", "the latest import of"; not "files your scripts
    // import", "at the top import React"
    pos = 'noun';
  } else if (object) {
    pos = 'verb';
  } else if (prev === null && inflected) {
    pos = null; // "Uses: cleaning", "Uses vary"
  } else if (prev === null && form.usual === 'noun') {
    pos = 'verb'; // "Rerun npm install", "Then rerun."
  } else if (word === 'use' && prevRaw === null) {
    // Clause-initial "Use X" is an instruction; not "Use cases …", "Use:".
    pos =
      next && !PREPOSITIONS.has(next) && !NOUN_AFTER_USE.has(next)
        ? 'verb'
        : null;
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
