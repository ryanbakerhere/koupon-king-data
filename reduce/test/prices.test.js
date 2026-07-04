import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updatePriceSeries, computeBaselines, loadPrices, isoWeekOf } from '../src/prices.js';

function snapshotWith(validFrom, price, regular = null, family = 'fam_a') {
  return {
    offers: [{
      offer_family: family,
      valid_from: validFrom,
      value: { type: 'member_price', price, regular_price: regular },
    }],
  };
}

test('isoWeekOf matches the tuple week format', () => {
  assert.equal(isoWeekOf('2026-06-29'), '2026-W27');
  assert.equal(isoWeekOf('2026-01-01'), '2026-W01');
});

test('series accumulates across weeks; baseline appears at 3 observations', () => {
  const publishedDir = mkdtempSync(join(tmpdir(), 'kk-prices-'));
  const weeks = [['2026-06-15', 3.49], ['2026-06-22', 3.49], ['2026-06-29', 2.99]];
  for (const [date, price] of weeks) {
    updatePriceSeries({ publishedDir, chainId: 'demo_mart', snapshots: [snapshotWith(date, price)], nowIso: `${date}T09:00:00Z` });
  }
  const doc = loadPrices(publishedDir, 'demo_mart');
  assert.equal(doc.families.fam_a.series.length, 3);

  const twoWeeks = computeBaselines(doc, '2026-W26');
  assert.equal(twoWeeks.get('fam_a'), undefined, 'only 2 obs inside window ending W26');

  const threeWeeks = computeBaselines(doc, '2026-W27');
  assert.deepEqual(threeWeeks.get('fam_a'), { baseline_price: 3.49, kind: 'member', observations: 3, window_weeks: 8 });
});

test('same-week rerun replaces, never duplicates (idempotent)', () => {
  const publishedDir = mkdtempSync(join(tmpdir(), 'kk-prices-'));
  const args = { publishedDir, chainId: 'demo_mart', snapshots: [snapshotWith('2026-06-29', 2.99)], nowIso: '2026-06-29T09:00:00Z' };
  assert.equal(updatePriceSeries(args).changed, true);
  assert.equal(updatePriceSeries(args).changed, false);
  assert.equal(loadPrices(publishedDir, 'demo_mart').families.fam_a.series.length, 1);
});

test('regular-kind observations are preferred for baselines when sufficient', () => {
  const publishedDir = mkdtempSync(join(tmpdir(), 'kk-prices-'));
  const weeks = [['2026-06-15', 2.99, 4.49], ['2026-06-22', 2.79, 4.49], ['2026-06-29', 2.99, 4.29]];
  for (const [date, price, regular] of weeks) {
    updatePriceSeries({ publishedDir, chainId: 'demo_mart', snapshots: [snapshotWith(date, price, regular)], nowIso: `${date}T09:00:00Z` });
  }
  const baselines = computeBaselines(loadPrices(publishedDir, 'demo_mart'), '2026-W27');
  assert.equal(baselines.get('fam_a').baseline_price, 4.49, 'median of regular observations, not member');
  assert.equal(baselines.get('fam_a').kind, 'regular');
});

test('observations older than the trailing window are excluded', () => {
  const publishedDir = mkdtempSync(join(tmpdir(), 'kk-prices-'));
  const weeks = [['2026-03-02', 5.99], ['2026-06-15', 3.49], ['2026-06-22', 3.49], ['2026-06-29', 3.29]];
  for (const [date, price] of weeks) {
    updatePriceSeries({ publishedDir, chainId: 'demo_mart', snapshots: [snapshotWith(date, price)], nowIso: `${date}T09:00:00Z` });
  }
  const baselines = computeBaselines(loadPrices(publishedDir, 'demo_mart'), '2026-W27');
  assert.deepEqual(baselines.get('fam_a'), { baseline_price: 3.49, kind: 'member', observations: 3, window_weeks: 8 });
});

test('non-member_price offers contribute nothing to the series', () => {
  const publishedDir = mkdtempSync(join(tmpdir(), 'kk-prices-'));
  const snapshot = { offers: [{ offer_family: 'fam_b', valid_from: '2026-06-29', value: { type: 'percent_off', percent: 50 } }] };
  updatePriceSeries({ publishedDir, chainId: 'demo_mart', snapshots: [snapshot], nowIso: '2026-06-29T09:00:00Z' });
  assert.deepEqual(loadPrices(publishedDir, 'demo_mart').families, {});
});
