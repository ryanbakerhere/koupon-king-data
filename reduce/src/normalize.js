// Implementation of the SCHEMAS.md §7 normalization grammar.
// Must stay in lockstep with scraper/src/normalize/text.ts and (later)
// app/src/matching/normalize.ts — parity is enforced by the golden vectors
// in reduce/test/normalize.vectors.json.

const SIZE_UNITS = new Map([
  ['oz', 'oz'], ['ounce', 'oz'], ['ounces', 'oz'],
  ['floz', 'floz'],
  ['lb', 'lb'], ['lbs', 'lb'], ['pound', 'lb'], ['pounds', 'lb'],
  ['l', 'l'], ['liter', 'l'], ['liters', 'l'], ['litre', 'l'], ['litres', 'l'],
  ['ml', 'ml'],
  ['g', 'g'], ['gram', 'g'], ['grams', 'g'],
  ['kg', 'kg'],
  ['ct', 'ct'], ['count', 'ct'],
  ['pk', 'pk'], ['pack', 'pk'],
]);

const NUM_RE = /^\d+(\.\d+)?$/;

function baseTokens(input) {
  let s = String(input ?? '').toLowerCase();
  s = s.normalize('NFKD').replace(/\p{M}+/gu, '');
  s = s.replace(/['’]/g, '');
  s = s.replace(/[^a-z0-9. ]+/g, ' ');
  s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
  return s.split(/\s+/).filter(Boolean);
}

function joinSizes(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (NUM_RE.test(t) && tokens[i + 1] === 'fl' && SIZE_UNITS.get(tokens[i + 2]) === 'oz') {
      out.push(t + 'floz');
      i += 2;
      continue;
    }
    if (NUM_RE.test(t) && i + 1 < tokens.length && SIZE_UNITS.has(tokens[i + 1])) {
      out.push(t + SIZE_UNITS.get(tokens[i + 1]));
      i += 1;
      continue;
    }
    const joined = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(t);
    if (joined && SIZE_UNITS.has(joined[2])) {
      out.push(joined[1] + SIZE_UNITS.get(joined[2]));
      continue;
    }
    out.push(t);
  }
  return out;
}

function findSubsequence(tokens, sub) {
  if (sub.length === 0) return -1;
  outer: for (let i = 0; i + sub.length <= tokens.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (tokens[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function normText(input, brands = []) {
  let tokens = joinSizes(baseTokens(input));

  for (const brand of brands) {
    const bTokens = joinSizes(baseTokens(brand));
    const idx = findSubsequence(tokens, bTokens);
    if (idx >= 0) {
      if (idx > 0) {
        tokens = [...bTokens, ...tokens.slice(0, idx), ...tokens.slice(idx + bTokens.length)];
      }
      break;
    }
  }

  let result = '';
  for (const t of tokens) {
    const next = result ? `${result} ${t}` : t;
    if (next.length > 80) break;
    result = next;
  }
  if (!result && tokens.length > 0) result = tokens[0].slice(0, 80);
  return result;
}
