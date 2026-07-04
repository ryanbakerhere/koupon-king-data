import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, copyFileSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { publishAll } from '../src/publish.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NOW = '2026-07-03T09:00:00Z';

function setup(registryFixture) {
  const dir = mkdtempSync(join(tmpdir(), 'kk-publish-'));
  const registryDir = join(dir, 'registry');
  cpSync(join(fixtures, registryFixture), registryDir, { recursive: true });
  return { registryDir, publishedDir: join(dir, 'published') };
}

function run(dirs) {
  return publishAll({ ...dirs, nowIso: NOW });
}

test('publishes valid snapshots, index.json, and an empty matches.json', () => {
  const dirs = setup('registry');
  const result = run(dirs);

  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.published.sort(), ['demo_mart/demo_mart-0001', 'demo_mart/demo_mart-0002']);

  const index = JSON.parse(readFileSync(join(dirs.publishedDir, 'index.json'), 'utf8'));
  assert.equal(index.schema_version, 1);
  assert.equal(index.chains.length, 1);
  const stores = index.chains[0].stores;
  assert.deepEqual(stores.map((s) => s.store_id), ['demo_mart-0001', 'demo_mart-0002']);
  assert.equal(stores[0].snapshot_url, 'stores/demo_mart/demo_mart-0001.json');
  assert.equal(stores[0].snapshot_version, '2026-07-03');
  assert.ok(stores[0].snapshot_bytes_gz > 0);
  assert.equal(typeof stores[0].lat, 'number');

  const matches = JSON.parse(readFileSync(join(dirs.publishedDir, 'matches.json'), 'utf8'));
  assert.deepEqual(matches.entries, []);
  assert.equal(index.matches_version, '2026-07-03');
});

test('published snapshots strip registry-internal offer_family', () => {
  const dirs = setup('registry');
  run(dirs);
  const published = JSON.parse(readFileSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0001.json'), 'utf8'));
  for (const offer of published.offers) {
    assert.ok(!('offer_family' in offer));
    assert.deepEqual(Object.keys(offer), [
      'offer_id', 'route', 'title', 'description', 'value', 'valid_from', 'valid_to',
      'deeplink', 'batch_clip_hint', 'hints', 'upcs_verified', 'insert_ref',
    ]);
  }
});

test('second run with unchanged registry changes nothing', () => {
  const dirs = setup('registry');
  run(dirs);
  const before = readFileSync(join(dirs.publishedDir, 'index.json'), 'utf8');
  const again = run(dirs);
  assert.equal(again.indexChanged, false);
  assert.equal(readFileSync(join(dirs.publishedDir, 'index.json'), 'utf8'), before);
});

test('malformed snapshot is rejected; valid sibling still publishes', () => {
  const dirs = setup('registry-bad');
  copyFileSync(
    join(fixtures, 'registry', 'demo_mart', 'demo_mart-0001.json'),
    join(dirs.registryDir, 'demo_mart', 'demo_mart-0001.json'),
  );
  const result = run(dirs);

  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].store_id, 'demo_mart-0666');
  assert.ok(result.rejected[0].errors.some((e) => e.includes('forbidden key')));
  assert.ok(result.rejected[0].errors.some((e) => e.includes('deeplink')));

  assert.ok(existsSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0001.json')));
  assert.ok(!existsSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0666.json')));
  const index = JSON.parse(readFileSync(join(dirs.publishedDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.chains[0].stores.map((s) => s.store_id), ['demo_mart-0001']);
});

test('store removed from registry is removed from published (orphan cleanup)', () => {
  const dirs = setup('registry');
  run(dirs);
  assert.ok(existsSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0002.json')));

  rmSync(join(dirs.registryDir, 'demo_mart', 'demo_mart-0002.json'));
  const directory = JSON.parse(readFileSync(join(dirs.registryDir, 'demo_mart', 'stores.json'), 'utf8'));
  directory.stores = directory.stores.filter((s) => s.store_id !== 'demo_mart-0002');
  writeFileSync(join(dirs.registryDir, 'demo_mart', 'stores.json'), JSON.stringify(directory, null, 2));

  const result = run(dirs);
  assert.deepEqual(result.removed, ['demo_mart/demo_mart-0002']);
  assert.ok(!existsSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0002.json')));
});

test('store in directory with no snapshot yet is not an error', () => {
  const dirs = setup('registry');
  rmSync(join(dirs.registryDir, 'demo_mart', 'demo_mart-0002.json'));
  const result = run(dirs);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.published, ['demo_mart/demo_mart-0001']);
});
