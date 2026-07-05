import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bakeMatchesFromInbox } from '../src/reduce-flywheel.js';

function tuple(over = {}) {
  return {
    v: 1, chain_id: 'safeway', offer_id: 'safeway:2026w27:8842', offer_family: 'gm_cereal_075',
    obs: { upc: '0001600027528', norm_text: null, source: 'shelf_tag' },
    matcher_tier: 1, match_confidence: 0.83, verdict: 'confirmed', signal: 'receipt', week: '2026-W27', ...over,
  };
}

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'kk-flywheel-'));
  const pub = join(root, 'data', 'published');
  mkdirSync(pub, { recursive: true });
  writeFileSync(join(pub, 'valid-offers.json'), JSON.stringify({
    schema_version: 1, offers: [{ offer_id: 'safeway:2026w27:8842', offer_family: 'gm_cereal_075', valid_to: '2026-07-05' }],
  }));
  writeFileSync(join(pub, 'matches.json'), JSON.stringify({ schema_version: 1, generated_at: '2026-07-01T00:00:00Z', entries: [] }));
  return root;
}

function writeBatch(root, day, name, tuples) {
  const dir = join(root, 'data', 'inbox', day);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify({ v: 1, app_build: '1.0.0', tuples }));
}

test('END-TO-END: three batches confirm → matches.json publishes a verified entry, inbox archived', () => {
  const root = scaffold();
  writeBatch(root, '2026-07-05', 'a.json', [tuple()]);
  writeBatch(root, '2026-07-05', 'b.json', [tuple()]);
  writeBatch(root, '2026-07-05', 'c.json', [tuple()]);

  const result = bakeMatchesFromInbox(root, '2026-07-05T09:00:00Z');
  assert.equal(result.processed, 3);
  assert.equal(result.changed, true);

  const matches = JSON.parse(readFileSync(join(root, 'data', 'published', 'matches.json'), 'utf8'));
  assert.equal(matches.entries.length, 1);
  assert.equal(matches.entries[0].status, 'verified');
  assert.equal(matches.entries[0].offer_family, 'gm_cereal_075');
  assert.equal(matches.entries[0].confirmations, 3);

  // inbox files moved to archive (immutable history), day dir emptied of batches
  assert.equal(existsSync(join(root, 'data', 'inbox', 'archive', '2026-07-05', 'a.json')), true);
  const remaining = readdirSync(join(root, 'data', 'inbox', '2026-07-05'));
  assert.deepEqual(remaining, []);
});

test('forged batches (family not in window) publish nothing', () => {
  const root = scaffold();
  writeBatch(root, '2026-07-05', 'x.json', [tuple({ offer_family: 'ghost_999' })]);
  writeBatch(root, '2026-07-05', 'y.json', [tuple({ offer_family: 'ghost_999' })]);
  writeBatch(root, '2026-07-05', 'z.json', [tuple({ offer_family: 'ghost_999' })]);
  const result = bakeMatchesFromInbox(root, '2026-07-05T09:00:00Z');
  assert.equal(result.stats.rejected, 3);
  const matches = JSON.parse(readFileSync(join(root, 'data', 'published', 'matches.json'), 'utf8'));
  assert.equal(matches.entries.length, 0);
});

test('a second run folds new votes into existing tallies (cumulative)', () => {
  const root = scaffold();
  writeBatch(root, '2026-07-05', 'a.json', [tuple()]);
  writeBatch(root, '2026-07-05', 'b.json', [tuple()]);
  bakeMatchesFromInbox(root, '2026-07-05T09:00:00Z'); // 2 confirmations → pending, not published
  let matches = JSON.parse(readFileSync(join(root, 'data', 'published', 'matches.json'), 'utf8'));
  assert.equal(matches.entries.length, 0);

  writeBatch(root, '2026-07-12', 'c.json', [tuple({ week: '2026-W28' })]); // 3rd distinct batch
  bakeMatchesFromInbox(root, '2026-07-12T09:00:00Z');
  matches = JSON.parse(readFileSync(join(root, 'data', 'published', 'matches.json'), 'utf8'));
  assert.equal(matches.entries.length, 1);
  assert.equal(matches.entries[0].status, 'verified');
  assert.equal(matches.entries[0].confirmations, 3);
});
