// Downloads third-party test data (not vendored: GPL / large) into .testdata/.
//   node scripts/fetch-test-data.mjs          verify against the pinned manifest
//   node scripts/fetch-test-data.mjs --pin    resolve HEAD SHAs, download, write the manifest
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'scripts', 'test-data.json');
const OUT = join(ROOT, '.testdata');

const hex = (n) => n.toString(16).padStart(2, '0');

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
  await pool(source.files, 4, async (file) => {
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
    if (expected && expected[file] !== sum) {
      throw new Error(`checksum mismatch for ${file}: expected ${expected[file]}, got ${sum}`);
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, buf);
    sums[file] = sum;
  });
  return sums;
}

const pin = process.argv.includes('--pin');
const manifest = {};
if (!pin) Object.assign(manifest, JSON.parse(await readFile(MANIFEST, 'utf8')));

for (const [name, source] of Object.entries(SOURCES)) {
  const sha = pin ? await headSha(source.repo) : manifest[name].sha;
  console.log(`${name}: ${source.repo}@${sha}`);
  const sums = await fetchSource(source, sha, pin ? null : manifest[name].files);
  if (pin) manifest[name] = { repo: source.repo, sha, files: sums };
}

if (pin) {
  await writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`wrote ${MANIFEST}`);
}
console.log('test data ready in .testdata/');
