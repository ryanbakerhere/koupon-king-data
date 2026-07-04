// Nightly publication job (BUILD_PLAN Phase 0 step 4).
// data/registry/ (scraper-pushed) → validate → data/published/ (CDN source):
//   published/stores/{chain}/{store_id}.json   per-store snapshot (SCHEMAS §2)
//   published/index.json                       store directory (SCHEMAS §1)
//   published/matches.json                     match table (empty until Phase 3 baking)
// Invalid snapshots are rejected and reported, never published; valid stores
// still go out. Output is written only when content actually changed, so a
// no-news night produces no commit churn.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { validateSnapshot, validateStoreDirectory, REGISTRY_ONLY_OFFER_KEYS } from './validate.js';

const OFFER_FIELD_ORDER = ['offer_id', 'route', 'title', 'description', 'value', 'valid_from', 'valid_to', 'deeplink', 'batch_clip_hint', 'hints', 'upcs_verified', 'insert_ref'];
const HINT_FIELD_ORDER = ['brands', 'category', 'size_min_oz', 'size_max_oz', 'keywords', 'excludes'];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return true;
}

function pick(obj, order) {
  const out = {};
  for (const k of order) out[k] = obj[k];
  return out;
}

// Rebuild the snapshot in canonical SCHEMAS §2 field order and drop
// registry-internal fields (e.g. offer_family) pending their SCHEMAS approval.
function canonicalSnapshot(snapshot) {
  return {
    schema_version: snapshot.schema_version,
    chain_id: snapshot.chain_id,
    store_id: snapshot.store_id,
    generated_at: snapshot.generated_at,
    valid_through_hint: snapshot.valid_through_hint,
    offers: snapshot.offers.map((offer) => {
      const clean = pick(offer, OFFER_FIELD_ORDER);
      clean.hints = pick(offer.hints, HINT_FIELD_ORDER);
      for (const k of REGISTRY_ONLY_OFFER_KEYS) delete clean[k];
      return clean;
    }),
  };
}

function listChains(registryDir) {
  if (!existsSync(registryDir)) return [];
  return readdirSync(registryDir)
    .filter((name) => statSync(join(registryDir, name)).isDirectory())
    .sort();
}

function sameIgnoringGeneratedAt(a, b) {
  return stringify({ ...a, generated_at: null }) === stringify({ ...b, generated_at: null });
}

export function publishAll({ registryDir, publishedDir, nowIso }) {
  const result = { published: [], rejected: [], removed: [], indexChanged: false };
  const storesDir = join(publishedDir, 'stores');
  const indexChains = [];

  for (const chainId of listChains(registryDir)) {
    const directoryPath = join(registryDir, chainId, 'stores.json');
    if (!existsSync(directoryPath)) {
      result.rejected.push({ chain_id: chainId, store_id: null, errors: ['missing stores.json directory file'] });
      continue;
    }
    let directory;
    try {
      directory = readJson(directoryPath);
    } catch (e) {
      result.rejected.push({ chain_id: chainId, store_id: null, errors: [`stores.json: invalid JSON (${e.message})`] });
      continue;
    }
    const dirCheck = validateStoreDirectory(directory, { chainId });
    if (!dirCheck.ok) {
      result.rejected.push({ chain_id: chainId, store_id: null, errors: dirCheck.errors });
      continue;
    }

    const indexStores = [];
    for (const store of [...directory.stores].sort((a, b) => a.store_id.localeCompare(b.store_id))) {
      const snapshotPath = join(registryDir, chainId, `${store.store_id}.json`);
      if (!existsSync(snapshotPath)) continue; // store known, no scrape yet — not an error
      let snapshot;
      try {
        snapshot = readJson(snapshotPath);
      } catch (e) {
        result.rejected.push({ chain_id: chainId, store_id: store.store_id, errors: [`invalid JSON (${e.message})`] });
        continue;
      }
      const check = validateSnapshot(snapshot, { chainId, storeId: store.store_id });
      if (!check.ok) {
        result.rejected.push({ chain_id: chainId, store_id: store.store_id, errors: check.errors });
        continue;
      }

      const content = stringify(canonicalSnapshot(snapshot));
      const outPath = join(storesDir, chainId, `${store.store_id}.json`);
      writeIfChanged(outPath, content);
      result.published.push(`${chainId}/${store.store_id}`);
      indexStores.push({
        store_id: store.store_id,
        display_name: store.display_name,
        lat: store.lat,
        lng: store.lng,
        geofence_radius_m: store.geofence_radius_m,
        snapshot_url: `stores/${chainId}/${store.store_id}.json`,
        snapshot_version: snapshot.generated_at.slice(0, 10),
        snapshot_bytes_gz: gzipSync(Buffer.from(content)).length,
      });
    }

    if (indexStores.length > 0) {
      indexChains.push({ chain_id: chainId, display_name: directory.display_name, stores: indexStores });
    }
  }

  // Orphan cleanup: the registry is the source of truth; published stores whose
  // registry entry disappeared are removed rather than left to go stale.
  const publishedKeys = new Set(result.published);
  if (existsSync(storesDir)) {
    for (const chainId of listChains(storesDir)) {
      for (const file of readdirSync(join(storesDir, chainId)).filter((f) => f.endsWith('.json'))) {
        const key = `${chainId}/${file.replace(/\.json$/, '')}`;
        if (!publishedKeys.has(key)) {
          rmSync(join(storesDir, chainId, file));
          result.removed.push(key);
        }
      }
      if (readdirSync(join(storesDir, chainId)).length === 0) rmSync(join(storesDir, chainId), { recursive: true });
    }
  }

  const matchesPath = join(publishedDir, 'matches.json');
  if (!existsSync(matchesPath)) {
    writeIfChanged(matchesPath, stringify({ schema_version: 1, generated_at: nowIso, entries: [] }));
  }
  const matches = readJson(matchesPath);

  const index = {
    schema_version: 1,
    generated_at: nowIso,
    chains: indexChains,
    matches_url: 'matches.json',
    matches_version: matches.generated_at.slice(0, 10),
  };
  const indexPath = join(publishedDir, 'index.json');
  const existingIndex = existsSync(indexPath) ? readJson(indexPath) : null;
  if (!existingIndex || !sameIgnoringGeneratedAt(existingIndex, index)) {
    writeIfChanged(indexPath, stringify(index));
    result.indexChanged = true;
  }

  return result;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = publishAll({
    registryDir: join(root, 'data', 'registry'),
    publishedDir: join(root, 'data', 'published'),
    nowIso: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  });
  console.log(`published: ${result.published.length} store(s)${result.indexChanged ? ' (index updated)' : ''}`);
  for (const key of result.removed) console.log(`removed orphan: ${key}`);
  for (const r of result.rejected) {
    console.error(`REJECTED ${r.chain_id}${r.store_id ? `/${r.store_id}` : ''}:`);
    for (const e of r.errors) console.error(`  - ${e}`);
  }
  if (result.rejected.length > 0) process.exit(1);
}
