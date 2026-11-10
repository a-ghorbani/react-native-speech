/**
 * Years read as years only in a year context (#32): "in 1984" → "nineteen
 * eighty-four", "1984 people" stays a number.
 */

import {numberToWords} from './numberWords';

export const YEAR = '(?:1[1-9]\\d\\d|20\\d\\d)';

const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?';

// "May 5, 2024", "May first, 2024", "May twenty-first, 2024" (ISO dates
// arrive in this form)
const DAY =
  '(?:\\d{1,2}|(?:twenty-|thirty-)?(?:first|second|third|(?:four|fif|six|seven|eigh|nin|ten|eleven|twelf|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)th|twentieth|thirtieth)),?';

// Months are case-sensitive ("may" is a verb); prepositions take either case.
const PREPOSITION =
  '[Ii]n|[Ss]ince|[Bb]y|[Ff]rom|[Uu]ntil|(?<!\\b[Oo]ut )[Oo]f|[Cc]irca|[Bb]efore|[Aa]fter|[Bb]etween|[Tt]hrough';

// "from roughly 2019 on"
const HEDGE = '(?: (?:roughly|about|around|approximately|early|mid|late))?';

// Not the "by" of a dimension ("1024 by 2048", from "1024x2048").
const TRIGGER = `(?:(?<!\\d )\\b(?:${PREPOSITION})${HEDGE}|\\b${MONTH}(?: ${DAY})?|\\bQ[1-4],?)`;

const NOT_IN_NUMBER_AFTER = '(?![.,:/-]?\\d|%|\\w| by \\d)';

const RE_CONTEXT = new RegExp(
  `(${TRIGGER}\\s+)(${YEAR})${NOT_IN_NUMBER_AFTER}(?:(\\s+(?:to|and|through|or)\\s+)(${YEAR})${NOT_IN_NUMBER_AFTER})?`,
  'g',
);

// A count, not a year, when one of these nouns follows a mid-sentence
// "in/of/by/after/before/from/between": "a context of 2048 tokens", "by 1500
// users". A closed list, and not after a sentence-opening "In 2020 people
// stayed home", a month ("May 2024 users") or "in" + people: those are years.
export const COUNT_NOUNS = [
  'tokens',
  'users',
  'people',
  'steps',
  'items',
  'words',
  'rows',
  'lines',
  'files',
  'bytes',
  'characters',
  'times',
  'messages',
  'requests',
  'samples',
  'records',
  'units',
  'entries',
  'iterations',
  'epochs',
  'runs',
  'tests',
  'calls',
  'queries',
  'documents',
  'pages',
  'sentences',
  'parameters',
  'examples',
  'images',
  'frames',
  'points',
  'results',
  'events',
  'downloads',
  'commits',
  'customers',
  'employees',
  'students',
  'dimensions',
];
const RE_COUNT_LEAD = /^(?:in|of|by|after|before|from|between)\b/;
// After "in", people are a year's subject ("back in 2020 people panicked").
const RE_PEOPLE_AFTER_IN =
  /^\s+(?:users|people|customers|employees|students)\b/i;
const RE_COUNT_NOUN_NEXT = new RegExp(
  `^\\s+(?:${COUNT_NOUNS.join('|')})\\b`,
  'i',
);

/** True when `rest` (the text after a number) starts with a count noun. */
export function countNounFollows(rest: string): boolean {
  return RE_COUNT_NOUN_NEXT.test(rest);
}

/** 1984 → "nineteen eighty-four", 2005 → "two thousand five". */
export function yearToWords(year: number): string {
  if (year >= 2000 && year <= 2009) return numberToWords(year);
  const hi = numberToWords(Math.floor(year / 100));
  const lo = year % 100;
  if (lo === 0) return `${hi} hundred`;
  if (lo < 10) return `${hi} oh ${numberToWords(lo)}`;
  return `${hi} ${numberToWords(lo)}`;
}

/**
 * A year behind "in/since/by/from/until/of/circa/before/after/between/
 * through" (optionally "roughly", "about", …), a month or a quarter ("Q4,
 * 2023"), plus the second year of "from 1990 to 2020"; not a count ("of
 * 2048 tokens", see COUNT_NOUNS). Runs after units, so "of 1955 ms" is already words.
 */
export function expandYears(text: string): string {
  return text.replace(
    RE_CONTEXT,
    (
      m: string,
      lead: string,
      a: string,
      join: string | undefined,
      b: string | undefined,
      offset: number,
    ) =>
      RE_COUNT_LEAD.test(lead) &&
      countNounFollows(text.slice(offset + m.length)) &&
      !(
        lead.startsWith('in') &&
        RE_PEOPLE_AFTER_IN.test(text.slice(offset + m.length))
      )
        ? m
        : lead + yearToWords(+a) + (join && b ? join + yearToWords(+b) : ''),
  );
}

// A 4-digit run inside a code reads in pairs, as people say model numbers:
// "SM8850" → "SM eighty-eight fifty", "RTX4090", "ad4255" in a hash. Glued to
// a letter before, or followed by letters and another digit ("5228ea0"); not
// a unit ("2048MB", already words by now).
const RE_CODE_DIGITS =
  /(?<=[A-Za-z])\d{4}(?!\d)|(?<![\w.])\d{4}(?=[A-Za-z]+\d)/g;

export function expandCodeDigits(text: string): string {
  return text.replace(RE_CODE_DIGITS, (m: string, at: number, s: string) =>
    +m >= 1100
      ? (/[^\s-]/.test(s[at - 1] ?? '') ? ' ' : '') +
        yearToWords(+m) +
        (/[^\s.,;:!?)\]»"'-]/.test(s[at + 4] ?? '') ? ' ' : '')
      : m,
  );
}
