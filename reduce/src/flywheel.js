// Flywheel reduction (SCHEMAS §3): inbox tuple batches → community match table.
//
// Spam defense WITHOUT identity. Tuples carry no user/device/install id (the
// privacy floor, SCHEMAS §4), so "independent confirmation" cannot mean
// "distinct user." It means **distinct batch**: each inbox file is one device's
// one weekly upload, and within a single batch a (mapping, verdict) counts
// exactly ONCE. So one device stuffing 200 identical confirmations into a batch
// = one vote; graduation (≥3) still needs three separate uploads, which the
// shim rate-limits per IP. No identity is stored, yet ballot-stuffing fails.
//
// Counts are cumulative in matches.json: each nightly run folds NEW inbox
// batches (deduped) into the existing tallies, then reclassifies. Inbox files
// are archived after processing, so every batch votes exactly once, ever.
//
// Graduation (SCHEMAS §3): verified when confirmations ≥ 3 AND confirmations ≥
// 2×denials. Demoted when denials ≥ confirmations. Blocklisted when denials ≥ 5
// with 0 confirmations. Everything else is pending (unpublished).

export const GRADUATE_MIN_CONFIRMATIONS = 3;
export const GRADUATE_RATIO = 2;
export const BLOCKLIST_MIN_DENIALS = 5;

function obsKey(upc, normText) {
  return upc ? `upc:${upc}` : `text:${normText}`;
}

export function mappingKeyOfTuple(t) {
  return `${t.chain_id}|${t.offer_family}|${obsKey(t.obs.upc || null, t.obs.norm_text || null)}`;
}

function mappingKeyOfEntry(e) {
  return `${e.chain_id}|${e.offer_family}|${obsKey(e.upc || null, e.norm_text || null)}`;
}

export function classify(confirmations, denials) {
  if (denials >= BLOCKLIST_MIN_DENIALS && confirmations === 0) return 'blocklisted';
  if (confirmations >= GRADUATE_MIN_CONFIRMATIONS && confirmations >= GRADUATE_RATIO * denials) return 'verified';
  if (denials >= confirmations && denials > 0) return 'demoted';
  return null; // pending — not published
}

function tupleIsAcceptable(t, validFamilyKeys) {
  if (!t || typeof t !== 'object') return false;
  if (t.verdict !== 'confirmed' && t.verdict !== 'denied') return false;
  if (!t.obs || typeof t.obs !== 'object') return false;
  if (!t.obs.upc && !t.obs.norm_text) return false;
  if (typeof t.chain_id !== 'string' || typeof t.offer_family !== 'string') return false;
  // The mapping's family must be in the current valid-offer window (SCHEMAS §9);
  // a tuple for an offer that never existed (or long expired) is forged/stale.
  return validFamilyKeys.has(`${t.chain_id}|${t.offer_family}`);
}

/**
 * @param existingEntries prior matches.json `entries` (cumulative tallies)
 * @param newBatches array of batches ({tuples:[...]} or a bare tuple array)
 * @param validFamilyKeys Set of `${chain_id}|${offer_family}` in the §9 window
 */
export function reduceFlywheel(existingEntries, newBatches, validFamilyKeys) {
  const agg = new Map();
  for (const e of existingEntries || []) {
    agg.set(mappingKeyOfEntry(e), {
      chain_id: e.chain_id,
      offer_family: e.offer_family,
      upc: e.upc || null,
      norm_text: e.norm_text || null,
      confirmations: e.confirmations || 0,
      denials: e.denials || 0,
      lastConfirmed: e.last_confirmed || null,
    });
  }

  let accepted = 0;
  let rejected = 0;
  for (const batch of newBatches || []) {
    const tuples = Array.isArray(batch) ? batch : (batch && batch.tuples) || [];
    const seenInBatch = new Set(); // (mapping, verdict) → counted once per batch
    for (const t of tuples) {
      if (!tupleIsAcceptable(t, validFamilyKeys)) {
        rejected++;
        continue;
      }
      const key = mappingKeyOfTuple(t);
      const ballot = `${key}|${t.verdict}`;
      if (seenInBatch.has(ballot)) continue; // self-vote within a batch — ignored, not counted
      seenInBatch.add(ballot);
      accepted++;

      let e = agg.get(key);
      if (!e) {
        e = {
          chain_id: t.chain_id, offer_family: t.offer_family,
          upc: t.obs.upc || null, norm_text: t.obs.norm_text || null,
          confirmations: 0, denials: 0, lastConfirmed: null,
        };
        agg.set(key, e);
      }
      if (t.verdict === 'confirmed') {
        e.confirmations++;
        if (t.week && t.week > (e.lastConfirmed || '')) e.lastConfirmed = t.week;
      } else {
        e.denials++;
      }
    }
  }

  // allMappings persists to the internal tally file (every mapping incl.
  // pending — vote counts must survive across nightly runs so weekly-jittered
  // uploads can accumulate to graduation). entries is the PUBLIC subset baked
  // into matches.json (only classified: verified | demoted | blocklisted).
  const allMappings = [];
  const entries = [];
  for (const e of agg.values()) {
    const status = classify(e.confirmations, e.denials) || 'pending';
    const row = {
      chain_id: e.chain_id,
      upc: e.upc,
      norm_text: e.norm_text,
      offer_family: e.offer_family,
      confirmations: e.confirmations,
      denials: e.denials,
      last_confirmed: e.lastConfirmed,
      status,
    };
    allMappings.push(row);
    if (status !== 'pending') entries.push(row);
  }
  const bySort = (a, b) =>
    a.chain_id.localeCompare(b.chain_id) ||
    a.offer_family.localeCompare(b.offer_family) ||
    String(a.upc).localeCompare(String(b.upc)) ||
    String(a.norm_text).localeCompare(String(b.norm_text));
  entries.sort(bySort);
  allMappings.sort(bySort);

  return { entries, allMappings, stats: { accepted, rejected, mappings: agg.size } };
}
