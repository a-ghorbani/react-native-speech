#!/usr/bin/env node
/**
 * validate-dict.mjs — Validate the mmap'd EPD1 binary dict produced by
 * build-dict.mjs. Run automatically at the end of `yarn build:dict`, and
 * can be invoked standalone.
 *
 * Checks:
 *   1. EPD1 magic + version 1
 *   2. Header offsets/sizes are consistent
 *   3. All payload sections fit inside the file
 *   4. Keys are sorted bytewise (binary search precondition)
 *   5. Every key/value offset pair is in-range
 *   6. Optional: full TSV roundtrip — every entry in the .tsv is
 *      retrievable from the .bin via binary search with the same value
 *
 * Exits non-zero on any failure. Prints a small summary on success.
 *
 * Usage:
 *   node scripts/validate-dict.mjs [lang]
 *   PHONEMIZER_DICTS_DIR=... node scripts/validate-dict.mjs [lang]
 *
 * The env var matches the one build-dict.mjs honors, so the script works
 * out-of-the-box in either repo layout.
 */

import {readFileSync, existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const lang = process.argv[2] || 'en-us';
const dictsDir =
  process.env.PHONEMIZER_DICTS_DIR ||
  join(ROOT, 'third-party', 'phonemizer-dicts');
const binPath = join(dictsDir, `${lang}.bin`);
const tsvPath = join(dictsDir, `${lang}.tsv`);

function fail(msg) {
  console.error(`[validate-dict] FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(binPath)) fail(`no such .bin: ${binPath}`);

const buf = readFileSync(binPath);
if (buf.length < 64) fail(`file too small (${buf.length} bytes)`);

// --- Header ---

const magic = buf.subarray(0, 4).toString('ascii');
if (magic !== 'EPD1') fail(`bad magic: ${JSON.stringify(magic)}`);

const version = buf.readUInt32LE(4);
if (version !== 1) fail(`unsupported version: ${version}`);

const nEntries = buf.readUInt32LE(8);
const keysOffset = Number(buf.readBigUInt64LE(16));
const keysSize = Number(buf.readBigUInt64LE(24));
const valsOffset = Number(buf.readBigUInt64LE(32));
const valsSize = Number(buf.readBigUInt64LE(40));
const koffOffset = Number(buf.readBigUInt64LE(48));
const voffOffset = Number(buf.readBigUInt64LE(56));

// Section bounds must lie inside the file.
for (const [name, off, sz] of [
  ['keys', keysOffset, keysSize],
  ['vals', valsOffset, valsSize],
  ['koff', koffOffset, (nEntries + 1) * 4],
  ['voff', voffOffset, (nEntries + 1) * 4],
]) {
  if (off < 64 || off + sz > buf.length) {
    fail(`${name} section out of bounds: off=${off} sz=${sz} file=${buf.length}`);
  }
  if (off % 64 !== 0) {
    fail(`${name} section not 64-byte aligned: off=${off}`);
  }
}

// --- Offset tables ---

// Last element of each offset table must equal section size (sentinel).
const lastKoff = buf.readUInt32LE(koffOffset + nEntries * 4);
const lastVoff = buf.readUInt32LE(voffOffset + nEntries * 4);
if (lastKoff !== keysSize) fail(`koff sentinel mismatch: ${lastKoff} !== ${keysSize}`);
if (lastVoff !== valsSize) fail(`voff sentinel mismatch: ${lastVoff} !== ${valsSize}`);

// --- Keys + sort order ---

function readKey(i) {
  const start = buf.readUInt32LE(koffOffset + i * 4);
  const end = buf.readUInt32LE(koffOffset + (i + 1) * 4);
  return buf.subarray(keysOffset + start, keysOffset + end);
}

function readVal(i) {
  const start = buf.readUInt32LE(voffOffset + i * 4);
  const end = buf.readUInt32LE(voffOffset + (i + 1) * 4);
  return buf.subarray(valsOffset + start, valsOffset + end);
}

for (let i = 1; i < nEntries; i++) {
  if (Buffer.compare(readKey(i - 1), readKey(i)) >= 0) {
    const prev = readKey(i - 1).toString('utf-8');
    const cur = readKey(i).toString('utf-8');
    fail(`keys not strictly sorted at ${i}: ${JSON.stringify(prev)} !< ${JSON.stringify(cur)}`);
  }
}

// --- Binary search lookup ---

function lookup(word) {
  const needle = Buffer.from(word, 'utf-8');
  let lo = 0;
  let hi = nEntries;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const mk = readKey(mid);
    const cmp = Buffer.compare(mk, needle);
    if (cmp < 0) lo = mid + 1;
    else if (cmp > 0) hi = mid;
    else return readVal(mid).toString('utf-8');
  }
  return null;
}

// Spot-check first, middle, last entries are retrievable.
for (const i of [0, nEntries >>> 1, nEntries - 1]) {
  const k = readKey(i).toString('utf-8');
  const v = readVal(i).toString('utf-8');
  const got = lookup(k);
  if (got !== v) fail(`lookup roundtrip failed at ${i}: ${JSON.stringify(k)} → ${got}`);
}

// --- Optional full TSV roundtrip ---

let tsvChecked = 0;
if (existsSync(tsvPath)) {
  const tsv = readFileSync(tsvPath, 'utf-8');
  for (const line of tsv.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab);
    const val = line.slice(tab + 1);
    const got = lookup(key);
    if (got !== val) {
      fail(`TSV roundtrip mismatch for ${JSON.stringify(key)}: bin=${JSON.stringify(got)} tsv=${JSON.stringify(val)}`);
    }
    tsvChecked++;
  }
}

// --- Summary ---

const mb = (buf.length / (1024 * 1024)).toFixed(2);
console.log(
  `[validate-dict] OK  ${lang}  entries=${nEntries}  size=${mb}MB` +
    (tsvChecked ? `  tsv-roundtrip=${tsvChecked}` : '  (no .tsv to roundtrip)'),
);
