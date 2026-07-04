import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSnapshot, validateStoreDirectory } from '../src/validate.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'registry', 'demo_mart');
const ctx = { chainId: 'demo_mart', storeId: 'demo_mart-0001' };

function goodSnapshot() {
  return JSON.parse(readFileSync(join(fixturesDir, 'demo_mart-0001.json'), 'utf8'));
}

function goodDirectory() {
  return JSON.parse(readFileSync(join(fixturesDir, 'stores.json'), 'utf8'));
}

test('fixture snapshot validates clean', () => {
  const result = validateSnapshot(goodSnapshot(), ctx);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
});

test('fixture store directory validates clean', () => {
  const result = validateStoreDirectory(goodDirectory(), { chainId: 'demo_mart' });
  assert.deepEqual(result.errors, []);
});

test('member_price with null regular_price is valid (2026-07-03(b) amendment)', () => {
  const s = goodSnapshot();
  s.offers[1].value = { type: 'member_price', price: 2.99, regular_price: null };
  assert.deepEqual(validateSnapshot(s, ctx).errors, []);
});

const snapshotRejections = [
  ['unknown offer field', (s) => { s.offers[0].bonus_field = 1; }],
  ['bad route', (s) => { s.offers[0].route = 'teleport'; }],
  ['clip offer missing deeplink', (s) => { s.offers[0].deeplink = null; }],
  ['auto_apply offer carrying deeplink', (s) => { s.offers[1].deeplink = 'https://x.example/y'; }],
  ['http (non-https) deeplink', (s) => { s.offers[0].deeplink = 'http://insecure.example/offer'; }],
  ['nested barcode-ish key anywhere', (s) => { s.offers[0].hints.gs1_databar = '811000'; }],
  ['serial-ish key anywhere', (s) => { s.offers[0].value.serial_no = 'abc'; }],
  ['bad UPC digits', (s) => { s.offers[0].upcs_verified = ['12345']; }],
  ['missing hints', (s) => { delete s.offers[0].hints; }],
  ['duplicate offer_id', (s) => { s.offers[1] = { ...s.offers[0] }; }],
  ['valid_from after valid_to', (s) => { s.offers[0].valid_from = '2026-08-01'; }],
  ['insert_ref on a clip route', (s) => { s.offers[0].insert_ref = 'SmartSource 2026-06-29'; }],
  ['offer_id not scoped to chain', (s) => { s.offers[0].offer_id = 'other_chain:2026w27:a1b2c3d4'; }],
  ['member_price not below regular', (s) => { s.offers[1].value = { type: 'member_price', price: 4.49, regular_price: 4.49 }; }],
  ['wrong schema_version', (s) => { s.schema_version = 2; }],
  ['empty title', (s) => { s.offers[0].title = '  '; }],
  ['missing offer_family (required since 2026-07-03 amendment)', (s) => { delete s.offers[0].offer_family; }],
];

for (const [name, mutate] of snapshotRejections) {
  test(`snapshot rejected: ${name}`, () => {
    const s = goodSnapshot();
    mutate(s);
    assert.equal(validateSnapshot(s, ctx).ok, false);
  });
}

const directoryRejections = [
  ['latitude out of range', (d) => { d.stores[0].lat = 123; }],
  ['duplicate store_id', (d) => { d.stores[1].store_id = d.stores[0].store_id; }],
  ['store_id not prefixed by chain', (d) => { d.stores[0].store_id = 'megamart-0001'; }],
  ['geofence radius at door scale', (d) => { d.stores[0].geofence_radius_m = 10; }],
  ['empty stores', (d) => { d.stores = []; }],
];

for (const [name, mutate] of directoryRejections) {
  test(`directory rejected: ${name}`, () => {
    const d = goodDirectory();
    mutate(d);
    assert.equal(validateStoreDirectory(d, { chainId: 'demo_mart' }).ok, false);
  });
}
