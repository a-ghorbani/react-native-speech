#!/usr/bin/env node
/**
 * build-dict.mjs — Build mmap'd EPD1 binary dict from a TSV.
 *
 * Input:  third-party/phonemizer-dicts/<lang>.tsv   (word\tipa per line)
 * Output: third-party/phonemizer-dicts/<lang>.bin   (EPD1 format)
 *
 * Format (little-endian):
 *   0   4   MAGIC "EPD1"
 *   4   4   VERSION uint32 = 1
 *   8   4   N_ENTRIES uint32
 *   12  4   padding
 *   16  8   KEYS_OFFSET uint64
 *   24  8   KEYS_SIZE uint64
 *   32  8   VALS_OFFSET uint64
 *   40  8   VALS_SIZE uint64
 *   48  8   KOFF_OFFSET uint64  (uint32[N+1])
 *   56  8   VOFF_OFFSET uint64  (uint32[N+1])
 *   64  ... payload sections (each 64-byte aligned)
 *
 * Keys are sorted bytewise (UTF-8). Values are parallel to keys (not sorted).
 */

import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const lang = process.argv[2] || 'en-us';
const inPath = join(ROOT, 'third-party', 'phonemizer-dicts', `${lang}.tsv`);
const outPath = join(ROOT, 'third-party', 'phonemizer-dicts', `${lang}.bin`);

const MAGIC = Buffer.from('EPD1', 'ascii');
const VERSION = 1;

console.log(`[build-dict] Reading ${inPath}`);
const text = readFileSync(inPath, 'utf8');

const enc = new TextEncoder();
const entries = [];
for (const line of text.split('\n')) {
  if (!line) continue;
  const tab = line.indexOf('\t');
  if (tab <= 0) continue;
  const key = line.slice(0, tab);
  const val = line.slice(tab + 1);
  entries.push([Buffer.from(enc.encode(key)), Buffer.from(enc.encode(val))]);
}

// Sort by raw UTF-8 bytes
entries.sort((a, b) => Buffer.compare(a[0], b[0]));

const n = entries.length;
console.log(`[build-dict] ${n} entries`);

// Compute payload sizes
const koffBytes = (n + 1) * 4;
const voffBytes = (n + 1) * 4;
let keysSize = 0;
let valsSize = 0;
for (const [k, v] of entries) {
  keysSize += k.length;
  valsSize += v.length;
}

// Layout: header(64) | keys_blob | pad | vals_blob | pad | koff | pad | voff
const HEADER = 64;
const align = (off, a = 64) => (off + (a - 1)) & ~(a - 1);

const keysOffset = align(HEADER);
const valsOffset = align(keysOffset + keysSize);
const koffOffset = align(valsOffset + valsSize);
const voffOffset = align(koffOffset + koffBytes);
const totalSize = voffOffset + voffBytes;

const buf = Buffer.alloc(totalSize);

// Header
MAGIC.copy(buf, 0);
buf.writeUInt32LE(VERSION, 4);
buf.writeUInt32LE(n, 8);
// padding 12..16
buf.writeBigUInt64LE(BigInt(keysOffset), 16);
buf.writeBigUInt64LE(BigInt(keysSize), 24);
buf.writeBigUInt64LE(BigInt(valsOffset), 32);
buf.writeBigUInt64LE(BigInt(valsSize), 40);
buf.writeBigUInt64LE(BigInt(koffOffset), 48);
buf.writeBigUInt64LE(BigInt(voffOffset), 56);

// Keys + key offsets
{
  let kpos = keysOffset;
  let kacc = 0;
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(kacc, koffOffset + i * 4);
    const k = entries[i][0];
    k.copy(buf, kpos);
    kpos += k.length;
    kacc += k.length;
  }
  buf.writeUInt32LE(kacc, koffOffset + n * 4);
}

// Vals + val offsets
{
  let vpos = valsOffset;
  let vacc = 0;
  for (let i = 0; i < n; i++) {
    buf.writeUInt32LE(vacc, voffOffset + i * 4);
    const v = entries[i][1];
    v.copy(buf, vpos);
    vpos += v.length;
    vacc += v.length;
  }
  buf.writeUInt32LE(vacc, voffOffset + n * 4);
}

writeFileSync(outPath, buf);

console.log(`[build-dict] Wrote ${outPath}`);
console.log(`[build-dict] entries=${n}`);
console.log(`[build-dict] keys_size=${keysSize} vals_size=${valsSize}`);
console.log(`[build-dict] file_size=${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
