// Validators for the registry layer of the commons (SCHEMAS.md §1–2).
// Everything that enters data/published/ passes through here first — this code
// is public because the gate to the commons must be as auditable as the commons.

export const ROUTES = ['auto_apply', 'clip', 'external', 'in_wallet_ref'];

// Non-negotiable (CLAUDE.md #2): no barcode payloads or serials, anywhere, ever.
// Any key that even smells like one is rejected regardless of nesting depth.
const FORBIDDEN_KEY_RE = /barcode|serial|gs1/i;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const CHAIN_ID_RE = /^[a-z0-9_]+$/;
const UPC_RE = /^\d{12,14}$/;
const OFFER_FAMILY_RE = /^[a-z0-9_]+$/;

const SNAPSHOT_KEYS = ['schema_version', 'chain_id', 'store_id', 'generated_at', 'valid_through_hint', 'offers'];
const OFFER_KEYS = ['offer_id', 'offer_family', 'route', 'title', 'description', 'value', 'valid_from', 'valid_to', 'deeplink', 'batch_clip_hint', 'hints', 'upcs_verified', 'insert_ref'];
const HINT_KEYS = ['brands', 'category', 'size_min_oz', 'size_max_oz', 'keywords', 'excludes'];
const DIRECTORY_KEYS = ['schema_version', 'chain_id', 'display_name', 'stores'];
const STORE_KEYS = ['store_id', 'display_name', 'lat', 'lng', 'geofence_radius_m'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isHttpsUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function scanForbiddenKeys(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, i) => scanForbiddenKeys(item, `${path}[${i}]`, errors));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_RE.test(k)) {
        errors.push(`${path}.${k}: forbidden key (barcode/serial data must never enter the registry)`);
      }
      scanForbiddenKeys(v, `${path}.${k}`, errors);
    }
  }
}

function checkKeys(obj, allowed, path, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${path}: unknown field "${k}"`);
  }
}

function validateValue(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  switch (value.type) {
    case 'amount_off':
      checkKeys(value, ['type', 'amount', 'currency'], path, errors);
      if (!(typeof value.amount === 'number' && value.amount > 0)) errors.push(`${path}.amount: must be a positive number`);
      if (value.currency !== 'USD') errors.push(`${path}.currency: must be "USD"`);
      break;
    case 'percent_off':
      checkKeys(value, ['type', 'percent'], path, errors);
      if (!(typeof value.percent === 'number' && value.percent > 0 && value.percent <= 100)) errors.push(`${path}.percent: must be in (0, 100]`);
      break;
    case 'member_price':
      checkKeys(value, ['type', 'price', 'regular_price'], path, errors);
      if (!(typeof value.price === 'number' && value.price > 0)) errors.push(`${path}.price: must be a positive number`);
      if (!(typeof value.regular_price === 'number' && value.regular_price > value.price)) errors.push(`${path}.regular_price: must exceed price`);
      break;
    default:
      errors.push(`${path}.type: must be amount_off | percent_off | member_price`);
  }
}

function validateHints(hints, path, errors) {
  if (!isPlainObject(hints)) {
    errors.push(`${path}: hints object is REQUIRED (SCHEMAS §2)`);
    return;
  }
  checkKeys(hints, HINT_KEYS, path, errors);
  for (const k of ['brands', 'keywords', 'excludes']) {
    const arr = hints[k];
    if (!Array.isArray(arr) || arr.some((s) => !isNonEmptyString(s))) {
      errors.push(`${path}.${k}: must be an array of non-empty strings`);
    }
  }
  if (!isNonEmptyString(hints.category)) errors.push(`${path}.category: must be a non-empty string`);
  for (const k of ['size_min_oz', 'size_max_oz']) {
    if (!(hints[k] === null || (typeof hints[k] === 'number' && hints[k] > 0))) {
      errors.push(`${path}.${k}: must be null or a positive number`);
    }
  }
  if (typeof hints.size_min_oz === 'number' && typeof hints.size_max_oz === 'number' && hints.size_min_oz > hints.size_max_oz) {
    errors.push(`${path}: size_min_oz exceeds size_max_oz`);
  }
}

function validateOffer(offer, chainId, index, errors) {
  const path = `offers[${index}]`;
  if (!isPlainObject(offer)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  checkKeys(offer, OFFER_KEYS, path, errors);

  const offerIdRe = new RegExp(`^${chainId}:[a-z0-9]+:[a-z0-9-]+$`);
  if (typeof offer.offer_id !== 'string' || !offerIdRe.test(offer.offer_id)) {
    errors.push(`${path}.offer_id: must match ${chainId}:<window>:<id>`);
  }
  if (typeof offer.offer_family !== 'string' || !OFFER_FAMILY_RE.test(offer.offer_family)) {
    errors.push(`${path}.offer_family: required, must match ${OFFER_FAMILY_RE} (SCHEMAS §2, 2026-07-03 amendment)`);
  }
  if (!ROUTES.includes(offer.route)) errors.push(`${path}.route: must be one of ${ROUTES.join(' | ')}`);
  if (!isNonEmptyString(offer.title) || offer.title.length > 200) errors.push(`${path}.title: non-empty string ≤ 200 chars`);
  if (!isNonEmptyString(offer.description)) errors.push(`${path}.description: must be a non-empty string`);
  validateValue(offer.value, `${path}.value`, errors);

  for (const k of ['valid_from', 'valid_to']) {
    if (typeof offer[k] !== 'string' || !DATE_RE.test(offer[k])) errors.push(`${path}.${k}: must be YYYY-MM-DD`);
  }
  if (DATE_RE.test(offer.valid_from ?? '') && DATE_RE.test(offer.valid_to ?? '') && offer.valid_from > offer.valid_to) {
    errors.push(`${path}: valid_from is after valid_to`);
  }

  const needsDeeplink = offer.route === 'clip' || offer.route === 'external';
  if (needsDeeplink) {
    if (!isHttpsUrl(offer.deeplink)) errors.push(`${path}.deeplink: https URL required for route "${offer.route}"`);
  } else if (offer.deeplink !== null) {
    errors.push(`${path}.deeplink: must be null for route "${offer.route}" (SCHEMAS §2)`);
  }
  if (!(offer.batch_clip_hint === null || isHttpsUrl(offer.batch_clip_hint))) {
    errors.push(`${path}.batch_clip_hint: must be null or an https URL`);
  }

  validateHints(offer.hints, `${path}.hints`, errors);

  if (!Array.isArray(offer.upcs_verified) || offer.upcs_verified.some((u) => typeof u !== 'string' || !UPC_RE.test(u))) {
    errors.push(`${path}.upcs_verified: must be an array of 12–14 digit strings`);
  }

  const paperRoutes = offer.route === 'external' || offer.route === 'in_wallet_ref';
  if (offer.insert_ref !== null && !(paperRoutes && isNonEmptyString(offer.insert_ref))) {
    errors.push(`${path}.insert_ref: must be null, or a non-empty string on external/in_wallet_ref routes`);
  }

}

export function validateSnapshot(snapshot, { chainId, storeId }) {
  const errors = [];
  if (!isPlainObject(snapshot)) return { ok: false, errors: ['snapshot: must be an object'] };

  checkKeys(snapshot, SNAPSHOT_KEYS, 'snapshot', errors);
  if (snapshot.schema_version !== 1) errors.push('schema_version: must be 1');
  if (snapshot.chain_id !== chainId) errors.push(`chain_id: expected "${chainId}"`);
  if (snapshot.store_id !== storeId) errors.push(`store_id: expected "${storeId}"`);
  if (typeof snapshot.generated_at !== 'string' || !ISO_UTC_RE.test(snapshot.generated_at)) {
    errors.push('generated_at: must be ISO 8601 UTC (…Z)');
  }
  if (!(snapshot.valid_through_hint === null || (typeof snapshot.valid_through_hint === 'string' && DATE_RE.test(snapshot.valid_through_hint)))) {
    errors.push('valid_through_hint: must be null or YYYY-MM-DD');
  }

  if (!Array.isArray(snapshot.offers)) {
    errors.push('offers: must be an array');
  } else {
    const seen = new Set();
    snapshot.offers.forEach((offer, i) => {
      validateOffer(offer, chainId, i, errors);
      if (isPlainObject(offer) && typeof offer.offer_id === 'string') {
        if (seen.has(offer.offer_id)) errors.push(`offers[${i}]: duplicate offer_id "${offer.offer_id}"`);
        seen.add(offer.offer_id);
      }
    });
  }

  scanForbiddenKeys(snapshot, 'snapshot', errors);
  return { ok: errors.length === 0, errors };
}

export function validateStoreDirectory(directory, { chainId }) {
  const errors = [];
  if (!isPlainObject(directory)) return { ok: false, errors: ['directory: must be an object'] };

  checkKeys(directory, DIRECTORY_KEYS, 'directory', errors);
  if (directory.schema_version !== 1) errors.push('schema_version: must be 1');
  if (directory.chain_id !== chainId || !CHAIN_ID_RE.test(chainId)) errors.push(`chain_id: expected slug "${chainId}"`);
  if (!isNonEmptyString(directory.display_name)) errors.push('display_name: must be a non-empty string');

  if (!Array.isArray(directory.stores) || directory.stores.length === 0) {
    errors.push('stores: must be a non-empty array');
    return { ok: false, errors };
  }

  const storeIdRe = new RegExp(`^${chainId}-[a-z0-9-]+$`);
  const seen = new Set();
  directory.stores.forEach((store, i) => {
    const path = `stores[${i}]`;
    if (!isPlainObject(store)) {
      errors.push(`${path}: must be an object`);
      return;
    }
    checkKeys(store, STORE_KEYS, path, errors);
    if (typeof store.store_id !== 'string' || !storeIdRe.test(store.store_id)) {
      errors.push(`${path}.store_id: must match ${chainId}-<id>`);
    } else {
      if (seen.has(store.store_id)) errors.push(`${path}: duplicate store_id "${store.store_id}"`);
      seen.add(store.store_id);
    }
    if (!isNonEmptyString(store.display_name)) errors.push(`${path}.display_name: must be a non-empty string`);
    if (!(typeof store.lat === 'number' && store.lat >= -90 && store.lat <= 90)) errors.push(`${path}.lat: must be in [-90, 90]`);
    if (!(typeof store.lng === 'number' && store.lng >= -180 && store.lng <= 180)) errors.push(`${path}.lng: must be in [-180, 180]`);
    if (!(typeof store.geofence_radius_m === 'number' && store.geofence_radius_m >= 100 && store.geofence_radius_m <= 5000)) {
      errors.push(`${path}.geofence_radius_m: must be 100–5000 (approach radius, SPEC §6.1)`);
    }
  });

  scanForbiddenKeys(directory, 'directory', errors);
  return { ok: errors.length === 0, errors };
}
