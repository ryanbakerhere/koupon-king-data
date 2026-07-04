import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normText } from '../src/normalize.js';

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'normalize.vectors.json'), 'utf8'));

for (const c of vectors.cases) {
  test(`normalize: ${c.name}`, () => {
    assert.equal(normText(c.input, c.brands ?? []), c.expected);
  });
}

test('normalize: output never exceeds 80 chars', () => {
  for (const c of vectors.cases) {
    assert.ok(normText(c.input, c.brands ?? []).length <= 80);
  }
});
