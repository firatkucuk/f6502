// Downloads third-party test data (not vendored: GPL / large) into .testdata/.
//   node scripts/fetch-test-data.mjs          verify against the pinned manifest
//   node scripts/fetch-test-data.mjs --pin    resolve HEAD SHAs, download, write the manifest
//   node scripts/fetch-test-data.mjs --pin <source>...  pin only the named sources (klaus,
//       singlestep, openroms, vicetests, sidtests); other manifest entries are kept. A bare --pin re-pins ALL sources
//       and re-downloads everything (singlestep is about 1.1 GB).
//   node scripts/fetch-test-data.mjs <source>...        verify/download only the named sources
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts', 'test-data.json');
const OUT = join(ROOT, '.testdata');

const hex = (n) => n.toString(16).padStart(2, '0');

function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execSync('gh auth token', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

async function apiJson(url) {
  const token = githubToken();
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'f6502-fetch-test-data',
      Accept: 'application/vnd.github+json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** PAL VIC-II tests that ship a reference screenshot: <dir>/<name>.prg + <dir>/references/<name>.prg.png */
async function listViceTests(repo, sha) {
  const base = `https://api.github.com/repos/${repo}/contents`;
  const dirs = (await apiJson(`${base}/VICII?ref=${sha}`)) ?? [];
  const files = [];
  for (const dir of dirs.filter((d) => d.type === 'dir')) {
    const refs = await apiJson(`${base}/VICII/${dir.name}/references?ref=${sha}`);
    if (!refs) continue;
    for (const ref of refs) {
      if (!ref.name.endsWith('.prg.png') || /ntsc/i.test(ref.name)) continue;
      files.push(`VICII/${dir.name}/references/${ref.name}`);
      files.push(`VICII/${dir.name}/${ref.name.slice(0, -'.png'.length)}`);
    }
  }
  return files.sort();
}

/** Every file below <dir> (recursive), for sources that are fetched whole. */
async function listTree(repo, sha, dir) {
  const base = `https://api.github.com/repos/${repo}/contents`;
  const out = [];
  const walk = async (path) => {
    const entries = (await apiJson(`${base}/${path}?ref=${sha}`)) ?? [];
    for (const e of entries) {
      if (e.type === 'dir') await walk(e.path);
      else if (e.type === 'file') out.push(e.path);
    }
  };
  await walk(dir);
  return out.sort();
}

const SOURCES = {
  klaus: {
    repo: 'Klaus2m5/6502_65C02_functional_tests',
    dest: 'klaus',
    files: [
      // Upstream ships prebuilt binaries only for the functional test. The decimal and
      // interrupt tests are source-only (AS65 syntax); assemble them yourself and drop the
      // .bin files into .testdata/klaus/bin_files/ to enable the optional runners.
      'bin_files/6502_functional_test.bin',
      'bin_files/6502_functional_test.lst',
      '6502_functional_test.a65',
      '6502_decimal_test.a65',
      '6502_interrupt_test.a65',
    ],
  },
  singlestep: {
    repo: 'SingleStepTests/65x02',
    dest: 'singlestep',
    files: Array.from({ length: 256 }, (_, i) => `6502/v1/${hex(i)}.json`),
  },
  openroms: {
    repo: 'MEGA65/open-roms',
    dest: 'openroms',
    files: [
      'bin/kernal_generic.rom',
      'bin/basic_generic.rom',
      'bin/chargen_openroms.rom',
      'LICENSE',
      'COPYING',
    ],
  },
  vicetests: { repo: 'libsidplayfp/VICE-testprogs', dest: 'vicetests', list: listViceTests },
  sidtests: {
    repo: 'libsidplayfp/VICE-testprogs',
    dest: 'sidtests',
    list: (repo, sha) => listTree(repo, sha, 'SID'),
  },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'f6502-fetch-test-data' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (String(error?.message).startsWith('404')) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw lastError;
}

async function headSha(repo) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/HEAD`, {
    headers: { 'User-Agent': 'f6502-fetch-test-data', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`cannot resolve HEAD of ${repo}: ${res.status}`);
  return (await res.json()).sha;
}

async function pool(items, size, fn) {
  const results = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

async function cached(dest, expectedSum) {
  try {
    const buf = await readFile(dest);
    return sha256(buf) === expectedSum ? expectedSum : null;
  } catch {
    return null;
  }
}

async function fetchSource(source, sha, expected) {
  const sums = {};
  const files = expected
    ? Object.keys(expected)
    : source.list
      ? await source.list(source.repo, sha)
      : source.files;
  await pool(files, 4, async (file) => {
    const dest = join(OUT, source.dest, file);
    if (expected) {
      const hit = await cached(dest, expected[file]);
      if (hit) {
        sums[file] = hit;
        return;
      }
    }
    const url = `https://raw.githubusercontent.com/${source.repo}/${sha}/${file}`;
    const buf = await get(url);
    const sum = sha256(buf);
    if (expected && expected[file] === undefined) {
      throw new Error(
        `${file} is not in the manifest: re-pin with "node scripts/fetch-test-data.mjs --pin ${source.dest}"`,
      );
    }
    if (expected && expected[file] !== sum) {
      throw new Error(`checksum mismatch for ${file}: expected ${expected[file]}, got ${sum}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    sums[file] = sum;
  });
  return sums;
}

const args = process.argv.slice(2);
const pin = args.includes('--pin');
const names = args.filter((a) => !a.startsWith('--'));
const selected = names.length > 0 ? names : Object.keys(SOURCES);
for (const n of selected) {
  if (!SOURCES[n]) {
    throw new Error(`unknown source '${n}' (known: ${Object.keys(SOURCES).join(', ')})`);
  }
}

let manifest = {};
try {
  manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
} catch {
  if (!pin) throw new Error(`${MANIFEST} missing: run with --pin first`);
}

for (const name of selected) {
  const source = SOURCES[name];
  const entry = manifest[name];
  if (!pin && !entry) throw new Error(`source '${name}' is not pinned: run with --pin ${name}`);
  const sha = pin ? await headSha(source.repo) : entry.sha;
  console.log(`${name}: ${source.repo}@${sha}`);
  const sums = await fetchSource(source, sha, pin ? null : entry.files);
  if (pin) manifest[name] = { repo: source.repo, sha, files: sums };
}

if (pin) {
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${MANIFEST}`);
}
console.log('test data ready in .testdata/');
