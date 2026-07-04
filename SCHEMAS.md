# SCHEMAS.md — Koupon King data contracts

These schemas are the contract between the app, scraper, shim, and reduce jobs.
Changing any field requires updating every consumer and bumping the relevant
`schema_version`. TypeScript types in `app/src/` and validation in `shim/` and `reduce/`
must be generated from / checked against this document.

Conventions: all timestamps ISO 8601 UTC; all IDs lowercase snake/kebab as shown;
all JSON published to the CDN is gzip-served with ETags.

---

## 1. `index.json` — store directory (CDN root)

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-07-03T09:00:00Z",
  "chains": [
    {
      "chain_id": "chain_a",            // stable slug, matches CAPABILITY_MATRIX row
      "display_name": "Chain A",
      "stores": [
        {
          "store_id": "chain_a-0421",
          "display_name": "Chain A — Elm St",
          "lat": 0.0,
          "lng": 0.0,
          "geofence_radius_m": 800,      // pre-fetch trigger radius (approach, not door)
          "snapshot_url": "stores/chain_a/chain_a-0421.json",
          "snapshot_version": "2026-07-03",
          "snapshot_bytes_gz": 148223
        }
      ]
    }
  ],
  "matches_url": "matches.json",
  "matches_version": "2026-07-03"
}
```

## 2. Per-store deal snapshot — `stores/{chain}/{store_id}.json`

```jsonc
{
  "schema_version": 1,
  "chain_id": "chain_a",
  "store_id": "chain_a-0421",
  "generated_at": "2026-07-03T08:41:00Z",
  "valid_through_hint": "2026-07-08",
  "offers": [
    {
      "offer_id": "chain_a:2026w27:8842",  // stable within validity window; chain-scoped
      "offer_family": "gm_cereal_075",      // stable across weekly rotation (§3); scraper-assigned
      "route": "clip",                      // auto_apply | clip | external | in_wallet_ref
      "title": "$0.75 off General Mills cereal",
      "description": "Any General Mills cereal, 10.8 oz or larger. Limit 2.",
      "value": { "type": "amount_off", "amount": 0.75, "currency": "USD" },
      //        { "type": "percent_off", "percent": 50 }
      //        { "type": "member_price", "price": 2.99, "regular_price": 4.49 }
      //          member_price.regular_price is number|null — flyers rarely disclose
      //          the regular price (2026-07-03 amendment). When null, savings
      //          magnitude is unknown to the flyer; clients grade via
      //          baseline_price (below) or a neutral low tier.
      "valid_from": "2026-06-29",
      "valid_to": "2026-07-05",
      "deeplink": "https://<retailer offer URL>",   // clip/external only; null otherwise
      "batch_clip_hint": null,                       // optional list-view clip URL
      "hints": {                                     // matcher inputs — REQUIRED
        "brands": ["general mills"],
        "category": "cereal",
        "size_min_oz": 10.8,
        "size_max_oz": null,
        "keywords": ["cheerios", "chex", "cinnamon toast crunch"],
        "excludes": ["single-serve", "cups"]
      },
      "upcs_verified": ["0001600027528"],  // from matches.json graduation; may be []
      "insert_ref": null,                   // external/paper: e.g. "SmartSource 2026-06-29"
      // PUBLISHED-ONLY additive fields (absent in registry input; reduce adds them
      // from the §10 price series when a confident baseline exists):
      "baseline_price": 4.49,               // historical usual price for this family
      "baseline_confidence": { "observations": 5, "window_weeks": 8 }
    }
  ]
}
```

Hard rules: no barcode payloads, no serials, no per-user fields, ever.
`in_wallet_ref` offers are registry *references* to known paper coupons (with
`insert_ref`) — the user's own wallet entries live only on-device (§6 below).

## 3. `matches.json` — community-verified match table

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-07-03T09:00:00Z",
  "entries": [
    {
      "chain_id": "chain_a",
      "upc": "0001600027528",              // present when tag barcode was the observation
      "norm_text": "cheerios honey nut 10.8oz", // normalized observed text (see §7)
      "offer_family": "gm_cereal_075",      // stable family key across weekly offer_ids
      "confirmations": 7,
      "denials": 1,
      "last_confirmed": "2026-07-01",
      "status": "verified"                  // verified | demoted | blocklisted
    }
  ]
}
```

Graduation rule (implemented in `reduce/`): ≥ 3 independent confirmations AND
confirmations ≥ 2 × denials. Demotion: denials ≥ confirmations. Blocklist: manual or
denials ≥ 5 with 0 confirmations.

`offer_family` exists because `offer_id`s rotate weekly while the underlying mapping
("this UPC is a GM cereal ≥10.8oz") is durable. The scraper assigns families via stable
hashing of normalized offer terms; reduce validates family continuity.

## 4. Flywheel tuple + batch (client → shim → `data/inbox/`)

Single tuple (client-side queue row):

```jsonc
{
  "v": 1,
  "chain_id": "chain_a",
  "offer_id": "chain_a:2026w27:8842",
  "offer_family": "gm_cereal_075",
  "obs": {
    "upc": "0001600027528",                // nullable — present if tag barcode read
    "norm_text": "cheerios honey nut 10.8oz", // nullable — normalized, max 80 chars
    "source": "shelf_tag"                   // shelf_tag | packaging
  },
  "matcher_tier": 1,                        // 0 | 1 | 2 | 3 (see SPEC §5.1)
  "match_confidence": 0.83,                 // matcher's score at display time
  "verdict": "confirmed",                   // confirmed | denied
  "signal": "receipt",                      // receipt | user_prompt
  "week": "2026-W27"                        // coarse time only — never a precise timestamp
}
```

Batch (the only thing the app ever uploads):

```jsonc
{
  "v": 1,
  "app_build": "1.0.3",       // for schema debugging only
  "tuples": [ /* 1–200 tuples */ ]
}
```

Absolute prohibitions in this payload: user IDs, device IDs, install IDs, precise
timestamps, coordinates, store_id (chain only — store-level location is a privacy leak
at low volumes), free-text fields beyond `norm_text` (which is machine-normalized, §7).

Shim validation (reject with 4xx): gzip JSON ≤ 32 KB, schema-valid, ≤ 200 tuples,
every `offer_id`/`offer_family` present in the recently-valid offer window (§9 —
offers retained 21 days past `valid_to`, so jittered weekly uploads survive weekly
offer rotation), `norm_text` matches the normalization grammar (§7). Accepted batches are written verbatim to
`data/inbox/{yyyy-mm-dd}/{random}.json` and are immutable thereafter.

## 5. Local stash / trip state (on-device SQLite — never uploaded)

Tables (indicative, Claude Code may refine):

- `trips(trip_id, chain_id, store_id, started_at, ended_at)`
- `stash(trip_id, offer_id, route, obs_upc, obs_text, matcher_tier, match_confidence,
  state)` — `state`: stashed | grabbed | clipped | handed_over | redeemed | failed
- `ledger(trip_id, offer_id, saved_amount, verified_by)` — verified_by: receipt | prompt
- `flywheel_queue(tuple_json, queued_at, uploaded_at NULL)`
- `wallet(wallet_id, photo_path, title, value_json, expires, parsed_at, archived)`

## 6. Paper wallet entry (on-device only)

The photo stays local. Parsed fields mirror offer `hints` so wallet items flow through
the same matcher as registry offers. No serial/barcode extraction — if OCR captures
digits under the barcode, they are discarded at parse time by policy.

## 7. Text normalization grammar (used by matcher, tuples, and matches.json)

`norm_text` = lowercase → unicode-fold → strip punctuation → collapse whitespace →
canonical size suffix (`10.8oz`, `2l`, `500g`) → brand tokens first if detected →
max 80 chars. One implementation, shared: `app/src/matching/normalize.ts` is the
reference; `reduce/` and `shim/` reimplementations must pass the same golden test
vectors (checked into `reduce/test/normalize.vectors.json`).

## 8. Versioning & compatibility

- Clients pin `schema_version` per file and ignore unknown fields (forward-compatible).
- Breaking changes: publish new files alongside old (`stores_v2/...`) for one release
  cycle; never mutate meaning of an existing field.
- The shim rejects tuple `v` values it doesn't know — old clients keep working, unknown
  future clients fail loudly.

## 9. `valid-offers.json` — shim validation index (published)

The rolling window of recently-valid offers that the shim validates tuple batches
against. Rebuilt by the nightly reduce so the shim stays a dumb gate and the
intelligence stays in `reduce/`: offers enter from the registry at publish time and
are retained for **21 days past `valid_to`**, because tuples upload on a jittered
weekly cadence (§4) while `offer_id`s rotate weekly — a receipt-verified tuple must
never bounce because its offer expired between the trip and the upload.

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-07-03T09:00:00Z",
  "retain_days_past_valid_to": 21,
  "offers": [
    { "offer_id": "chain_a:2026w27:8842", "offer_family": "gm_cereal_075", "valid_to": "2026-07-05" }
  ]
}
```

## 10. Price series & baselines — `prices/{chain}.json` (published)

The longitudinal price commons: a forward-accumulating, family-keyed record of
observed prices, updated by the nightly reduce from each week's registry. Purely a
derived view on data already public (the registry's commit history remains the
audit trail); no new collection. Published under the same ODbL as everything else —
an open grocery price time series.

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-07-04T02:30:00Z",
  "chain_id": "safeway",
  "families": {
    "signal_a1b2c3d4": {
      "series": [
        { "week": "2026-W27", "price": 2.99, "kind": "member" },
        { "week": "2026-W27", "price": 4.49, "kind": "regular" }
      ]
    }
  }
}
```

- `kind`: `member` (promo/member price observed) | `regular` (disclosed regular price).
- One entry per (family, week, kind); same-week reruns replace, never duplicate.
- **Baseline rule** (implemented in `reduce/`): `baseline_price` = median of
  `regular`-kind observations in a trailing 8-week window when ≥ 3 exist; else
  median of `member`-kind observations (≥ 3 distinct weeks) — an honest
  promo-price baseline until shelf-tag observations (Phase 2+) enrich the series.
  Emitted onto published §2 offers only with `baseline_confidence`
  `{observations, window_weeks}` alongside. Client precedence: tag-observed >
  baseline-inferred > unknown (neutral low tier).

## Amendments

- **2026-07-03 (b)** (operator-approved, relayed via Designer dispatch #2;
  `schema_version` unchanged — all additive): §2 `member_price.regular_price` is now
  nullable (flyers disclose it for ~3% of items; Q4 in WORKLOG). §2 gains
  published-only `baseline_price` + `baseline_confidence`. New §10 price-series
  commons (`prices/{chain}.json`) and the baseline inference rule.
- **2026-07-03** (operator-approved; `schema_version` unchanged — both changes are
  additive and forward-compatible per §8): §2 offers now carry `offer_family`
  (previously registry-internal), so client tuples inherit the scraper-assigned family
  from birth and `matches.json` continuity strengthens across weekly rotation. New §9
  `valid-offers.json` published index; §4 shim validation checks the §9 rolling window
  rather than the current registry only.
