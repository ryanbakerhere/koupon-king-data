// Price series & baseline inference (SCHEMAS §10, Designer dispatch #2).
// The nightly reduce appends each week's observed prices per offer_family into
// published/prices/{chain}.json — a forward-accumulating open time series (the
// registry's git history remains the audit trail). Baselines derived from the
// series let clients grade "Member Price $X" deals whose regular price the flyer
// never disclosed: the repo answers the flyer's silence with the flyer's own
// history. Purely a derived view; no new collection.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const BASELINE_WINDOW_WEEKS = 8;
export const BASELINE_MIN_OBSERVATIONS = 3;

export function isoWeekOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + 3);
  const year = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((date.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekIndex(week) {
  const [y, w] = week.split('-W').map(Number);
  return y * 53 + w;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const raw = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(raw * 100) / 100;
}

function pricesPath(publishedDir, chainId) {
  return join(publishedDir, 'prices', `${chainId}.json`);
}

export function loadPrices(publishedDir, chainId) {
  const path = pricesPath(publishedDir, chainId);
  if (!existsSync(path)) return { schema_version: 1, generated_at: null, chain_id: chainId, families: {} };
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Fold one week's validated snapshots into the chain's price series.
 * Observation per (family, week, kind): median across stores (usually identical).
 * Same-week reruns replace their entries — idempotent, never duplicating.
 */
export function updatePriceSeries({ publishedDir, chainId, snapshots, nowIso }) {
  const doc = loadPrices(publishedDir, chainId);
  const collected = new Map(); // `${family}|${week}|${kind}` → number[]

  for (const snapshot of snapshots) {
    for (const offer of snapshot.offers) {
      if (offer.value.type !== 'member_price') continue;
      const week = isoWeekOf(offer.valid_from);
      const push = (kind, price) => {
        const key = `${offer.offer_family}|${week}|${kind}`;
        if (!collected.has(key)) collected.set(key, []);
        collected.get(key).push(price);
      };
      push('member', offer.value.price);
      if (offer.value.regular_price !== null) push('regular', offer.value.regular_price);
    }
  }

  for (const [key, values] of collected) {
    const [family, week, kind] = key.split('|');
    if (!doc.families[family]) doc.families[family] = { series: [] };
    const series = doc.families[family].series;
    const entry = { week, price: median(values), kind };
    const at = series.findIndex((e) => e.week === week && e.kind === kind);
    if (at >= 0) series[at] = entry;
    else series.push(entry);
    series.sort((a, b) => a.week.localeCompare(b.week) || a.kind.localeCompare(b.kind));
  }

  const ordered = {
    schema_version: 1,
    generated_at: nowIso,
    chain_id: chainId,
    families: Object.fromEntries(Object.keys(doc.families).sort().map((f) => [f, doc.families[f]])),
  };
  const path = pricesPath(publishedDir, chainId);
  const next = JSON.stringify(ordered, null, 2) + '\n';
  const prev = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const changed = !prev
    || JSON.stringify({ ...JSON.parse(prev), generated_at: null })
    !== JSON.stringify({ ...ordered, generated_at: null });
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
  return { doc: ordered, changed };
}

/**
 * SCHEMAS §10 baseline rule: within a trailing window ending at currentWeek,
 * prefer the median of `regular` observations (≥ MIN), else the median of
 * `member` observations across ≥ MIN distinct weeks.
 */
export function computeBaselines(pricesDoc, currentWeek) {
  const cutoff = weekIndex(currentWeek) - (BASELINE_WINDOW_WEEKS - 1);
  const out = new Map();
  for (const [family, { series }] of Object.entries(pricesDoc.families)) {
    const inWindow = series.filter((e) => {
      const idx = weekIndex(e.week);
      return idx >= cutoff && idx <= weekIndex(currentWeek);
    });
    for (const kind of ['regular', 'member']) {
      const obs = inWindow.filter((e) => e.kind === kind);
      const weeks = new Set(obs.map((e) => e.week));
      if (weeks.size >= BASELINE_MIN_OBSERVATIONS) {
        out.set(family, {
          baseline_price: median(obs.map((e) => e.price)),
          observations: weeks.size,
          window_weeks: BASELINE_WINDOW_WEEKS,
        });
        break;
      }
    }
  }
  return out;
}
