// Flywheel reduce orchestration (SCHEMAS §3, SPEC §6.4): read inbox batches →
// fold into matches.json via reduceFlywheel → archive processed batches
// (immutable, SCHEMAS §4). Wired into the nightly Action after publish.js.
// Pure fs glue; all the intelligence is in flywheel.js.

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { reduceFlywheel } from './flywheel.js';

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function chainOf(offer) {
  if (offer.chain_id) return offer.chain_id;
  return typeof offer.offer_id === 'string' ? offer.offer_id.split(':')[0] : '';
}

export function bakeMatchesFromInbox(dataRoot, nowIso) {
  const publishedDir = join(dataRoot, 'data', 'published');
  const inboxDir = join(dataRoot, 'data', 'inbox');
  const matchesPath = join(publishedDir, 'matches.json');
  // Internal cumulative tally (ALL mappings incl. pending). NOT in published/,
  // so the CDN never serves it — but it is committed (public, auditable) so the
  // path from raw contributions to the match table stays inspectable.
  const talliesPath = join(dataRoot, 'data', 'flywheel-tallies.json');

  const tallies = readJson(talliesPath, { schema_version: 1, mappings: [] });
  const validOffers = readJson(join(publishedDir, 'valid-offers.json'), { offers: [] });
  const validFamilyKeys = new Set((validOffers.offers || []).map((o) => `${chainOf(o)}|${o.offer_family}`));

  // Collect inbox batch files (skip the archive subtree).
  const batchFiles = [];
  if (existsSync(inboxDir)) {
    for (const day of readdirSync(inboxDir)) {
      if (day === 'archive') continue;
      const dayDir = join(inboxDir, day);
      let files;
      try { files = readdirSync(dayDir); } catch { continue; }
      for (const f of files) if (f.endsWith('.json')) batchFiles.push({ day, file: f, path: join(dayDir, f) });
    }
  }
  const batches = batchFiles.map((b) => readJson(b.path, null)).filter(Boolean);

  const prevMatches = readJson(matchesPath, { entries: [] });
  const { entries, allMappings, stats } = reduceFlywheel(tallies.mappings || [], batches, validFamilyKeys);

  // Persist the full cumulative tally (seeds the next run's accumulation).
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(talliesPath, JSON.stringify({ schema_version: 1, generated_at: nowIso, mappings: allMappings }, null, 2) + '\n');

  const changed = JSON.stringify(prevMatches.entries || []) !== JSON.stringify(entries);
  if (changed || !existsSync(matchesPath)) {
    mkdirSync(publishedDir, { recursive: true });
    writeFileSync(matchesPath, JSON.stringify({ schema_version: 1, generated_at: nowIso, entries }, null, 2) + '\n');
  }

  // Archive processed batches — inbox files are immutable (SCHEMAS §4); move,
  // never delete, so the raw contribution history is auditable.
  for (const b of batchFiles) {
    const dest = join(inboxDir, 'archive', b.day);
    mkdirSync(dest, { recursive: true });
    renameSync(b.path, join(dest, b.file));
  }

  return { stats, processed: batchFiles.length, changed, entries };
}
