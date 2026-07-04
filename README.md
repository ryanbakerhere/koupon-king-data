# koupon-king-data — the open commons

This repository is the public dataset **and** the public refinery behind
[Koupon King](https://github.com/), a sovereign AR grocery-savings app: no accounts,
no tracking, on-device intelligence. The community-verified product↔offer match table
and the per-store deal registry live here as an open dataset, and the reduce scripts
that decide what enters the commons live right beside the data — because
"community-verified" should be a checkable claim, not a slogan.

Everything here is coupon **metadata only**: titles, values, dates, product hints,
verified UPC mappings. No barcode payloads, no serials, no user data — ever. Those are
hard rules enforced in `reduce/src/validate.js`, in public, on every publish.

## Layout

```
SCHEMAS.md          the public data contract (mirrored from the code repo — identical by rule)
LICENSE             ODbL 1.0 — share-alike open data license (the OpenStreetMap model)
reduce/             the refinery: validation + publication + (Phase 3) flywheel reduction
data/
  registry/         per-chain scraper output (internal producer format, documented below)
  inbox/            anonymous flywheel batches, committed by the ingestion shim
  published/        the read API — what apps and third parties consume
```

## Public read API (stable URLs, served via CDN)

| File | What it is | Schema |
|---|---|---|
| `index.json` | Store directory: chains, stores, geofence coords, snapshot versions | SCHEMAS.md §1 |
| `stores/{chain}/{store_id}.json` | Per-store deal snapshot | SCHEMAS.md §2 |
| `matches.json` | Community-verified product↔offer match table | SCHEMAS.md §3 |
| `valid-offers.json` | Rolling recently-valid offer window (shim validation index) | SCHEMAS.md §9 |
| `prices/{chain}.json` | Open longitudinal price series per chain (family-keyed) — feeds baseline inference | SCHEMAS.md §10 |

Base URL: **`https://data.kouponking.app/`** (canonical, Sovereign-owned domain —
goes live with the repo's public flip; published from `data/published/` via GitHub
Pages). All files are JSON, gzip-served with ETags. Third parties
consuming these files is a success condition of the project, not a leak — schema
stability rules (SCHEMAS.md §8) exist partly for your benefit. Build things.

## Registry format (producer-side, internal)

`data/registry/{chain_id}/` contains:

- `stores.json` — chain store directory: `{ schema_version, chain_id, display_name,
  stores: [{ store_id, display_name, lat, lng, geofence_radius_m }] }`
- `{store_id}.json` — a SCHEMAS.md §2 snapshot. Every offer carries `offer_family`
  (stable family key across weekly offer_id rotation — §2, 2026-07-03 amendment).

The registry is written by the (private) scraper node and validated by `reduce/` before
anything is published. Malformed input is rejected and reported, never published.

## How a match earns its way into `matches.json`

Anonymous confirmation tuples (SCHEMAS.md §4 — no user IDs, no locations, no precise
timestamps, chain-level only) arrive in `data/inbox/` through a ~30-line ingestion shim.
The nightly reduce job graduates a mapping only at **≥ 3 independent confirmations with
a ≥ 2:1 positive ratio**; denials demote, and persistent denials blocklist. The entire
pipeline — thresholds included — is in `reduce/`, unit-tested, and runs in public via
GitHub Actions. Audit it.

## License

The dataset is licensed under the **Open Database License (ODbL) 1.0** — the
OpenStreetMap model. Share and build on it freely, commercially or otherwise;
improvements to the database must stay open under the same terms. Full text in
`LICENSE`. The commons cannot be enclosed — that's the point.
