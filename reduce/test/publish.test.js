import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, copyFileSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
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

test('published snapshots carry offer_family in canonical order (SCHEMAS §2, 2026-07-03 amendment)', () => {
  const dirs = setup('registry');
  run(dirs);
  const published = JSON.parse(readFileSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0001.json'), 'utf8'));
  for (const offer of published.offers) {
    assert.match(offer.offer_family, /^[a-z0-9_]+$/);
    assert.deepEqual(Object.keys(offer), [
      'offer_id', 'offer_family', 'route', 'title', 'description', 'value', 'valid_from', 'valid_to',
      'deeplink', 'batch_clip_hint', 'hints', 'upcs_verified', 'insert_ref',
    ]);
  }
});

test('valid-offers.json holds the deduped offer window (SCHEMAS §9)', () => {
  const dirs = setup('registry');
  run(dirs);
  const validOffers = JSON.parse(readFileSync(join(dirs.publishedDir, 'valid-offers.json'), 'utf8'));
  assert.equal(validOffers.schema_version, 1);
  assert.equal(validOffers.retain_days_past_valid_to, 21);
  assert.equal(validOffers.offers.length, 4); // 3 offers in store 0001 + 1 in 0002, deduped
  const sorted = [...validOffers.offers].sort((a, b) => a.offer_id.localeCompare(b.offer_id));
  assert.deepEqual(validOffers.offers, sorted);
  for (const entry of validOffers.offers) {
    assert.deepEqual(Object.keys(entry), ['offer_id', 'offer_family', 'valid_to']);
  }
});

test('valid-offers.json retains rotated-out offers 21 days past valid_to, drops expired', () => {
  const dirs = setup('registry');
  mkdirSync(dirs.publishedDir, { recursive: true });
  writeFileSync(join(dirs.publishedDir, 'valid-offers.json'), JSON.stringify({
    schema_version: 1,
    generated_at: '2026-06-01T09:00:00Z',
    retain_days_past_valid_to: 21,
    offers: [
      // Gone from registry, valid_to 2026-06-20: +21d = 2026-07-11 ≥ NOW(07-03) → retained.
      { offer_id: 'demo_mart:2026w25:ffffffff', offer_family: 'old_fam_ffffffff', valid_to: '2026-06-20' },
      // Gone from registry, valid_to 2026-05-01: +21d = 2026-05-22 < NOW → dropped.
      { offer_id: 'demo_mart:2026w18:eeeeeeee', offer_family: 'old_fam_eeeeeeee', valid_to: '2026-05-01' },
    ],
  }, null, 2));

  run(dirs);
  const validOffers = JSON.parse(readFileSync(join(dirs.publishedDir, 'valid-offers.json'), 'utf8'));
  const ids = validOffers.offers.map((o) => o.offer_id);
  assert.ok(ids.includes('demo_mart:2026w25:ffffffff'));
  assert.ok(!ids.includes('demo_mart:2026w18:eeeeeeee'));
  assert.equal(validOffers.offers.length, 5); // 4 current + 1 retained
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

test('member-price offers gain baselines when the price series is confident (§10)', () => {
  const dirs = setup('registry');
  // Pre-seed three prior weeks of member-price history for the coffee family.
  mkdirSync(join(dirs.publishedDir, 'prices'), { recursive: true });
  writeFileSync(join(dirs.publishedDir, 'prices', 'demo_mart.json'), JSON.stringify({
    schema_version: 1,
    generated_at: '2026-06-22T09:00:00Z',
    chain_id: 'demo_mart',
    families: {
      demo_roast_b2c3d4e5: {
        series: [
          { week: '2026-W24', price: 3.49, kind: 'member' },
          { week: '2026-W25', price: 3.49, kind: 'member' },
          { week: '2026-W26', price: 3.29, kind: 'member' },
        ],
      },
    },
  }, null, 2));

  run(dirs);
  const published = JSON.parse(readFileSync(join(dirs.publishedDir, 'stores', 'demo_mart', 'demo_mart-0001.json'), 'utf8'));
  const coffee = published.offers.find((o) => o.offer_family === 'demo_roast_b2c3d4e5');
  // Window now holds member obs for W24–W27 (2.99 joined this week): median 3.39.
  assert.equal(coffee.baseline_price, 3.39);
  assert.deepEqual(coffee.baseline_confidence, { kind: 'member', observations: 4, window_weeks: 8 });
  const keys = Object.keys(coffee);
  assert.deepEqual(keys.slice(0, 8), ['offer_id', 'offer_family', 'route', 'title', 'description', 'value', 'baseline_price', 'baseline_confidence']);
  // Non-member_price offers (amount-off cereal) must NOT carry baselines.
  const cereal = published.offers.find((o) => o.offer_family === 'demo_crunch_a1b2c3d4');
  assert.ok(!('baseline_price' in cereal));

  const prices = JSON.parse(readFileSync(join(dirs.publishedDir, 'prices', 'demo_mart.json'), 'utf8'));
  assert.equal(prices.families.demo_roast_b2c3d4e5.series.length, 5, 'W27 adds member + regular observations');
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
