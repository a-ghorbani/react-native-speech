/**
 * Years read as years only in a year context (#32): "in 1984" → "nineteen
 * eighty-four", "1984 people" stays a number.
 */

import {numberToWords} from './numberWords';

export const YEAR = '(?:1[1-9]\\d\\d|20\\d\\d)';

const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\\.?';

// "May 5, 2024", "May first, 2024" (ISO dates arrive in this form)
const DAY = '(?:\\d{1,2}|[a-z-]*(?:first|second|third|th)),?';

// Months are case-sensitive ("may" is a verb); prepositions take either case.
const PREPOSITION =
  '[Ii]n|[Ss]ince|[Bb]y|[Ff]rom|[Uu]ntil|(?<!\\b[Oo]ut )[Oo]f|[Cc]irca|[Bb]efore|[Aa]fter|[Bb]etween|[Tt]hrough';

// "from roughly 2019 on"
const HEDGE = '(?: (?:roughly|about|around|approximately|early|mid|late))?';

const TRIGGER = `(?:\\b(?:${PREPOSITION})${HEDGE}|\\b${MONTH}(?: ${DAY})?|\\bQ[1-4],?)`;

const NOT_IN_NUMBER_AFTER = '(?![.,:/-]?\\d|%|\\w)';

const RE_CONTEXT = new RegExp(
  `(${TRIGGER}\\s+)(${YEAR})${NOT_IN_NUMBER_AFTER}(?:(\\s+(?:to|and|through|or)\\s+)(${YEAR})${NOT_IN_NUMBER_AFTER})?`,
  'g',
);

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
 * 2023"), plus the second year of "from 1990 to 2020". Runs after units, so
 * "of 1955 ms" is already words.
 */
export function expandYears(text: string): string {
  return text.replace(
    RE_CONTEXT,
    (
      _m: string,
      lead: string,
      a: string,
      join: string | undefined,
      b: string | undefined,
    ) => lead + yearToWords(+a) + (join && b ? join + yearToWords(+b) : ''),
  );
}

// A 4-digit run inside a code reads in pairs, as people say model numbers:
// "SM8850" → "SM eighty-eight fifty", "RTX4090", "ad4255" in a hash. Glued to
// a letter before, or followed by letters and another digit ("5228ea0"); not
// a unit ("2048MB", already words by now).
const RE_CODE_DIGITS =
  /(?<=[A-Za-z])\d{4}(?!\d)|(?<![\w.])\d{4}(?=[A-Za-z]+\d)/g;

export function expandCodeDigits(text: string): string {
  return text.replace(RE_CODE_DIGITS, (m: string) =>
    +m >= 1100 ? ` ${yearToWords(+m)} ` : m,
  );
}
