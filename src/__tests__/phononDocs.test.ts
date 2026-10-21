/**
 * Phonon docs stay in sync with the code they describe: support reasons,
 * error codes, config fields, build flags, defaults, pinned versions,
 * model licences and the links between the docs.
 */
import * as fs from 'fs';
import * as path from 'path';
import {PHONON_CONSTANTS, PHONON_LANGUAGES} from '../engines/phonon/constants';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const GUIDE = 'docs/PHONON_GUIDE.md';
const DOCS = [
  GUIDE,
  'README.md',
  'docs/USAGE.md',
  'docs/ARCHITECTURE.md',
  'docs/LICENSES.md',
  'CHANGELOG.md',
];

const guide = read(GUIDE);
const lock = JSON.parse(read('phonon.lock.json'));

/** Body of the `## heading` / `### heading` section, up to the next heading of that level or higher. */
function section(md: string, heading: string): string {
  const lines = md.split('\n');
  const start = lines.findIndex(
    l => /^#{2,3} /.test(l) && l.replace(/^#+ /, '') === heading,
  );
  if (start < 0) {
    throw new Error(`no section "${heading}"`);
  }
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level,
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
}

/** First-column backticked values of the markdown table rows in `md`. */
function firstColumn(md: string): string[] {
  return md
    .split('\n')
    .map(l => l.match(/^\| `([^`]+)` \|/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map(m => m[1]!);
}

/** String-literal members of `export type <name> = | 'a' | 'b';`. */
function unionMembers(rel: string, name: string): string[] {
  const src = read(rel);
  const m = src.match(new RegExp(`export type ${name} =([^;]+);`));
  if (!m) {
    throw new Error(`no type ${name} in ${rel}`);
  }
  return [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!);
}

/** GitHub's heading anchor. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(md: string): Set<string> {
  return new Set(
    md
      .split('\n')
      .filter(l => /^#{1,6} /.test(l))
      .map(l => slug(l.replace(/^#+ /, ''))),
  );
}

describe('Phonon guide: reference tables match the code', () => {
  it('lists exactly the PhononSupportReason values', () => {
    const reasons = unionMembers('src/types/Phonon.ts', 'PhononSupportReason');
    expect(reasons.length).toBeGreaterThan(5);
    expect(firstColumn(section(guide, 'Support reasons')).sort()).toEqual(
      [...reasons].sort(),
    );
  });

  it('lists exactly the PhononErrorCode values', () => {
    const codes = unionMembers(
      'src/engines/phonon/errors.ts',
      'PhononErrorCode',
    );
    expect(firstColumn(section(guide, 'Errors')).sort()).toEqual(
      [...codes].sort(),
    );
  });

  it('lists exactly the PhononConfig fields', () => {
    const src = read('src/types/Phonon.ts');
    const body = src.match(
      /export interface PhononConfig \{([\s\S]*?)\n\}/,
    )![1]!;
    const fields = [...body.matchAll(/^\s+(\w+)\??:/gm)].map(m => m[1]!);
    expect(fields).toContain('modelPath');
    expect(
      firstColumn(section(guide, 'Configuration (`PhononConfig`)')).sort(),
    ).toEqual([...fields].sort());
  });

  it('states the code defaults', () => {
    const config = section(guide, 'Configuration (`PhononConfig`)');
    const row = (field: string) =>
      config.split('\n').find(l => l.startsWith(`| \`${field}\` |`))!;
    expect(row('maxChunkSize')).toContain(
      `\`${PHONON_CONSTANTS.DEFAULT_MAX_CHUNK_SIZE}\``,
    );
    expect(row('language')).toContain(
      `\`'${PHONON_CONSTANTS.DEFAULT_LANGUAGE}'\``,
    );
    for (const lang of PHONON_LANGUAGES) {
      expect(row('language')).toContain(`'${lang}'`);
    }
    expect(row('computeUnit')).toContain(
      `\`'${PHONON_CONSTANTS.DEFAULT_COMPUTE_UNIT}'\``,
    );
    expect(PHONON_CONSTANTS.SAMPLE_RATE).toBe(24000);
    expect(guide).toMatch(/\| Sample rate \| 24 kHz \| 24 kHz \|/);
  });

  it('platform-specific config fields reach native or are marked ignored', () => {
    const engine = read('src/engines/phonon/PhononEngine.ts');
    const createOpts = engine.match(
      /NativePhonon\.create\(config\.modelPath, \{([\s\S]*?)\}\)/,
    )![1]!;
    const ignored = new Set(
      [
        ...engine.matchAll(
          /'(\w+) is not supported by this native build yet; ignored'/g,
        ),
      ].map(m => m[1]!),
    );
    const usage = read('docs/USAGE.md');
    const rows = section(guide, 'Configuration (`PhononConfig`)')
      .split('\n')
      .map(l => l.match(/^\| `(\w+)` \| (Android|iOS|both) \|(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null);
    expect(rows.length).toBeGreaterThan(5);
    for (const [, field, platform, rest] of rows) {
      if (ignored.has(field!)) {
        expect(rest).toMatch(/ignored/i);
        expect(usage).toMatch(new RegExp(`\`${field}\`[^\`]*ignored`));
      } else {
        expect(rest).not.toMatch(/ignored/i);
        if (platform !== 'both') {
          // A native tunable the docs call effective must be sent to native.
          expect(createOpts).toMatch(new RegExp(`\\b${field}\\b`));
        }
      }
    }
  });

  it('does not offer the iOS override as a read-only-store workaround while it copies into the package', () => {
    const fetch = read('ios/phonon/fetch.rb');
    const ensure = fetch.slice(fetch.indexOf('def ensure_xcframework!'));
    // The override and the release both end in one install_copy into the package.
    if (/local_override[\s\S]*install_copy\(src, dest/.test(ensure)) {
      for (const doc of [guide, read('docs/USAGE.md')]) {
        expect(doc).not.toMatch(
          /read-only[^.\n]*point `RN_SPEECH_PHONON_XCFRAMEWORK`/,
        );
        expect(doc).toMatch(/package folder must be writable/i);
      }
    }
  });

  it('quickstart snippets use the default voice', () => {
    // Named voices exist only if the app downloaded their files.
    for (const rel of DOCS) {
      expect(read(rel)).not.toMatch(/Speech\.speak\('Hello from Phonon\.', '/);
    }
  });

  it('states the watchdog bound used by the engine', () => {
    const bound = `max(${PHONON_CONSTANTS.WATCHDOG_MIN_MS / 1000} s, ${PHONON_CONSTANTS.WATCHDOG_FACTOR} × expected)`;
    expect(section(guide, 'Errors')).toContain(bound);
  });

  it('states the memory floor of both probes', () => {
    expect(
      read(
        'android/src/phononPure/java/com/pocketpalai/speech/phonon/PhononProbe.kt',
      ),
    ).toMatch(/MIN_TOTAL_MEM_BYTES = 3L shl 30/);
    expect(section(guide, 'Requirements and supported devices')).toContain(
      'At least 3 GiB of RAM',
    );
    expect(section(guide, 'Requirements and supported devices')).toContain(
      'At least 3 GiB of physical memory',
    );
  });
});

describe('Phonon docs: build flags exist in the build files', () => {
  const docsText = DOCS.map(read).join('\n');

  it('every documented Gradle property is read by the library build', () => {
    const gradle = read('android/build.gradle') + read('android/phonon.gradle');
    const props = new Set(
      [...docsText.matchAll(/RNSpeech_phonon(\w+)/g)].map(m => m[1]!),
    );
    expect(props).toContain('Enabled');
    expect(props).toContain('LibDir');
    for (const p of props) {
      const name = p[0]!.toLowerCase() + p.slice(1);
      // build.gradle reads them through getPhononOption("<name>") or the full property name.
      expect(
        gradle.includes(`"phonon${p}"`) ||
          gradle.includes(`RNSpeech_phonon${p}`) ||
          gradle.includes(`"${name}"`),
      ).toBe(true);
    }
  });

  it('every documented iOS environment variable is read by the pod', () => {
    const ios =
      read('RNSpeech.podspec') +
      read('ios/phonon/fetch.rb') +
      read('ios/phonon/RNSpeechPhonon.mm');
    const vars = new Set(
      [...docsText.matchAll(/\bRN_SPEECH_PHONON\w*/g)].map(m => m[0]),
    );
    expect(vars).toContain('RN_SPEECH_PHONON');
    expect(vars).toContain('RN_SPEECH_PHONON_XCFRAMEWORK');
    for (const v of vars) {
      expect(ios).toContain(v);
    }
    expect(read('ios/phonon/RNSpeechPhonon.mm')).toContain(
      'RNSpeechPhononForceReason',
    );
  });

  it('the documented example script exists', () => {
    const pkg = JSON.parse(read('example/package.json'));
    expect(pkg.scripts['build:android:phonon']).toBeDefined();
  });
});

describe('Phonon docs: versions, models and licences', () => {
  it('names the upstream tag and commit pinned in phonon.lock.json', () => {
    expect(guide).toContain(`\`${lock.upstream.tag}\``);
    const licenses = read('docs/LICENSES.md');
    expect(licenses).toContain(lock.upstream.tag);
    expect(licenses).toContain(lock.upstream.commit);
    expect(read('docs/phonon/THIRD_PARTY_NOTICES.md')).toContain(
      lock.upstream.commit,
    );
  });

  it('matches the example model manager (revision, files, voices)', () => {
    const mm = read('example/src/utils/PhononModelManager.ts');
    const rev = mm.match(
      /repo: 'gradium\/phonon-31m-en',\s+revision: '([0-9a-f]{40})'/,
    )![1]!;
    expect(guide).toContain(rev);
    const files = section(guide, 'Android: checkpoint folder');
    for (const f of [
      'config.json',
      'tokenizer.json',
      'model.q8.gguf',
      'default-voice.safetensors',
    ]) {
      expect(mm).toContain(`path: '${f}'`);
      expect(files).toContain(`\`${f}\``);
    }
    const curated = mm.slice(mm.indexOf('PHONON_CURATED_VOICES'));
    const names = [
      ...curated.slice(0, curated.indexOf('];')).matchAll(/name: '(\w+)'/g),
    ].map(m => m[1]!);
    expect(names).toHaveLength(8);
    const voices = section(guide, 'Voices');
    for (const n of names) {
      expect(voices).toContain(n);
    }
    expect(mm).toContain("repo: 'palshub/phonon-31m-en-coreml'");
    expect(guide).toContain('palshub/phonon-31m-en-coreml');
  });

  it('warns that Phonon 40m is CC BY-NC and 31m is Apache-2.0 everywhere', () => {
    for (const rel of [
      GUIDE,
      'docs/LICENSES.md',
      'README.md',
      'docs/USAGE.md',
      'CHANGELOG.md',
    ]) {
      const text = read(rel);
      expect(text).toMatch(/CC BY-NC/);
    }
    const licences = section(guide, 'Licences');
    expect(licences).toMatch(/Phonon 31m.*\| Apache-2\.0 \|/);
    expect(licences).toMatch(/Phonon 40m.*\| \*\*CC BY-NC 4\.0\*\* \|/);
    expect(read('docs/LICENSES.md')).toMatch(
      /\| Phonon 40m \|.*\*\*CC BY-NC 4\.0\*\*/,
    );
    expect(read('docs/LICENSES.md')).toMatch(
      /\| Phonon 31m \|.*\| Apache-2\.0 \|/,
    );
    // The binaries' own licence and notices.
    expect(read('docs/LICENSES.md')).toContain('MIT OR Apache-2.0');
    expect(read('docs/LICENSES.md')).toContain('phonon/THIRD_PARTY_NOTICES.md');
  });

  it('documents the missing speed control in every Phonon doc', () => {
    expect(section(guide, 'Limits')).toMatch(/No speed or pitch control/);
    expect(read('README.md')).toMatch(
      /Phonon\*\* has no speed or pitch control/,
    );
    expect(read('docs/USAGE.md')).toMatch(/no speed or pitch control/);
  });

  it('README engine table has a PHONON row linking the guide', () => {
    const engines = section(read('README.md'), 'Engines');
    const rows = firstColumn(engines);
    expect(rows).toEqual([
      'OS_NATIVE',
      'KOKORO',
      'SUPERTONIC',
      'KITTEN',
      'PHONON',
    ]);
    expect(engines).toMatch(/\| `PHONON` \|.*\*\*no\*\*.*PHONON_GUIDE\.md/);
  });

  it('has an Unreleased CHANGELOG entry for Phonon', () => {
    const changelog = read('CHANGELOG.md');
    const unreleased = changelog.slice(
      changelog.indexOf('## Unreleased'),
      changelog.indexOf('\n## ', changelog.indexOf('## Unreleased') + 1),
    );
    expect(unreleased).toMatch(/### Added[\s\S]*TTSEngine\.PHONON/);
    expect(unreleased).toContain('docs/PHONON_GUIDE.md');
  });
});

describe('Phonon docs: links resolve', () => {
  const linkRe = /\[[^\]]*\]\(([^)\s]+)\)|<a href="([^"]+)"/g;

  it.each(DOCS)('%s', rel => {
    const md = read(rel);
    const dir = path.dirname(path.join(ROOT, rel));
    const broken: string[] = [];
    for (const m of md.matchAll(linkRe)) {
      const target = (m[1] ?? m[2])!;
      if (/^(https?:|mailto:)/.test(target)) {
        continue;
      }
      const [file, anchor] = target.split('#') as [string, string | undefined];
      const abs = file ? path.resolve(dir, file) : path.join(ROOT, rel);
      if (!fs.existsSync(abs)) {
        broken.push(target);
        continue;
      }
      // Anchors are checked for markdown targets we own.
      if (
        anchor &&
        abs.endsWith('.md') &&
        /PHONON_GUIDE|scripts\/phonon|README\.md$/.test(abs)
      ) {
        if (!anchors(fs.readFileSync(abs, 'utf8')).has(anchor)) {
          broken.push(target);
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
