import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceFlywheel, classify } from '../src/flywheel.js';

const VALID = new Set(['safeway|gm_cereal_075', 'safeway|tide_pods_200']);

function tuple(over = {}) {
  return {
    v: 1, chain_id: 'safeway', offer_id: 'safeway:2026w27:8842', offer_family: 'gm_cereal_075',
    obs: { upc: '0001600027528', norm_text: null, source: 'shelf_tag' },
    matcher_tier: 1, match_confidence: 0.83, verdict: 'confirmed', signal: 'receipt', week: '2026-W27',
    ...over,
  };
}
function batch(tuples) { return { v: 1, app_build: '1.0.0', tuples }; }
const reduce = (batches, existing = []) => reduceFlywheel(existing, batches, VALID);

test('classify implements the SCHEMAS §3 thresholds exactly', () => {
  assert.equal(classify(3, 0), 'verified');
  assert.equal(classify(3, 1), 'verified');   // 3 >= 2*1
  assert.equal(classify(3, 2), null);          // 3 < 2*2 → pending, NOT verified (ratio guard)
  assert.equal(classify(2, 0), null);          // < 3 confirmations → pending
  assert.equal(classify(2, 3), 'demoted');     // denials >= confirmations
  assert.equal(classify(1, 1), 'demoted');
  assert.equal(classify(0, 5), 'blocklisted'); // 5 denials, 0 confirmations
  assert.equal(classify(0, 4), 'demoted');     // not yet blocklist
  assert.equal(classify(1, 5), 'demoted');     // has a confirmation → not blocklist
});

// ---- THE SPAM SUITE (BUILD_PLAN Phase 3 acceptance) ----

test('SPAM: one device stuffing 200 confirmations in ONE batch does NOT graduate', () => {
  const stuffed = batch(Array.from({ length: 200 }, () => tuple()));
  const { entries, stats } = reduce([stuffed]);
  // 200 identical confirmations in one batch → counted ONCE → pending
  assert.equal(entries.length, 0, 'no mapping should graduate from a single batch');
  assert.equal(stats.accepted, 1, 'the batch cast exactly one ballot for the mapping');
});

test('graduates only with THREE distinct batches confirming', () => {
  const three = [batch([tuple()]), batch([tuple()]), batch([tuple()])];
  const { entries } = reduce(three);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'verified');
  assert.equal(entries[0].confirmations, 3);
  assert.equal(entries[0].upc, '0001600027528');
});

test('a mix of confirm+deny in ONE batch counts each verdict once', () => {
  const mixed = batch([tuple(), tuple({ verdict: 'confirmed' }), tuple({ verdict: 'denied' })]);
  const { entries } = reduce([mixed]);
  // 1 confirm + 1 deny for the same mapping → demoted (denials >= confirmations)
  assert.equal(entries.length, 1);
  assert.equal(entries[0].confirmations, 1);
  assert.equal(entries[0].denials, 1);
  assert.equal(entries[0].status, 'demoted');
});

test('denials from 5 distinct batches with no confirmations → blocklisted', () => {
  const denies = Array.from({ length: 5 }, () => batch([tuple({ verdict: 'denied' })]));
  const { entries } = reduce(denies);
  assert.equal(entries[0].status, 'blocklisted');
  assert.equal(entries[0].denials, 5);
});

test('SPAM: tuples for an offer family NOT in the valid window are rejected', () => {
  const forged = batch([tuple({ offer_family: 'ghost_offer_999' })]);
  const { entries, stats } = reduce([forged, batch([tuple({ offer_family: 'ghost_offer_999' })]), batch([tuple({ offer_family: 'ghost_offer_999' })])]);
  assert.equal(entries.length, 0);
  assert.equal(stats.rejected, 3);
  assert.equal(stats.accepted, 0);
});

test('malformed tuples (no obs, bad verdict) are rejected, valid siblings survive', () => {
  const dirty = batch([
    tuple(),                                              // good
    { ...tuple(), obs: { upc: null, norm_text: null } },  // no observation
    tuple({ verdict: 'maybe' }),                          // bad verdict
  ]);
  const { stats } = reduce([dirty]);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.rejected, 2);
});

test('cumulative: new denials fold into an existing verified entry and can demote it', () => {
  const existing = [{
    chain_id: 'safeway', upc: '0001600027528', norm_text: null, offer_family: 'gm_cereal_075',
    confirmations: 3, denials: 0, last_confirmed: '2026-W27', status: 'verified',
  }];
  // four separate batches deny it → denials 4 >= confirmations 3 → demoted
  const denies = Array.from({ length: 4 }, () => batch([tuple({ verdict: 'denied' })]));
  const { entries } = reduce(denies, existing);
  assert.equal(entries[0].confirmations, 3);
  assert.equal(entries[0].denials, 4);
  assert.equal(entries[0].status, 'demoted');
});

test('distinct observations of the same family are distinct match-table rows', () => {
  // a UPC confirmation and a text confirmation for the same family → two mappings
  const batches = [
    batch([tuple()]), batch([tuple()]), batch([tuple()]),
    batch([tuple({ obs: { upc: null, norm_text: 'cheerios honey nut 10.8oz', source: 'packaging' } })]),
    batch([tuple({ obs: { upc: null, norm_text: 'cheerios honey nut 10.8oz', source: 'packaging' } })]),
    batch([tuple({ obs: { upc: null, norm_text: 'cheerios honey nut 10.8oz', source: 'packaging' } })]),
  ];
  const { entries } = reduce(batches);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.status === 'verified'));
  assert.ok(entries.some((e) => e.upc === '0001600027528'));
  assert.ok(entries.some((e) => e.norm_text === 'cheerios honey nut 10.8oz'));
});

test('last_confirmed tracks the most recent confirming week', () => {
  const batches = [
    batch([tuple({ week: '2026-W25' })]),
    batch([tuple({ week: '2026-W27' })]),
    batch([tuple({ week: '2026-W26' })]),
  ];
  const { entries } = reduce(batches);
  assert.equal(entries[0].last_confirmed, '2026-W27');
});
