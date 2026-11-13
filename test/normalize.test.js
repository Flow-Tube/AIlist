import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeHandle, normalizeEntries, extractHandle, MAX_HANDLE_LENGTH } from '../src/normalize.js';

const vectors = JSON.parse(readFileSync(new URL('./fixtures/normalize-vectors.json', import.meta.url), 'utf8'));

test('shared test vectors normalize exactly as documented', () => {
  assert.equal(vectors.length, 9);
  for (const { input, normalized } of vectors) {
    assert.equal(normalizeHandle(input), normalized, `input ${JSON.stringify(input)}`);
  }
});

test('empty and whitespace-only input is rejected', () => {
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle('   '), null);
  assert.equal(normalizeHandle('@'), null);
  assert.equal(normalizeHandle('/@/videos'), null);
});

test('length limit is 64 code points', () => {
  assert.equal(normalizeHandle('@' + 'a'.repeat(MAX_HANDLE_LENGTH)), 'a'.repeat(64));
  assert.equal(normalizeHandle('@' + 'a'.repeat(MAX_HANDLE_LENGTH + 1)), null);
  // Astral characters count once each, not as two UTF-16 units.
  const emoji = '\u{1F600}'.repeat(MAX_HANDLE_LENGTH);
  assert.equal(normalizeHandle('@' + emoji), emoji);
  assert.equal(normalizeHandle('@' + emoji + 'a'), null);
});

test('forbidden characters are rejected after decoding', () => {
  assert.equal(normalizeHandle('@a%20b'), null); // decodes to a space
  assert.equal(normalizeHandle('@a%40b'), null); // decodes to @
  assert.equal(normalizeHandle('@a%2Fb'), null); // decodes to /
  assert.equal(normalizeHandle('@a b'), null); // no-break space
});

test('handle extraction stops at / ? #', () => {
  assert.equal(extractHandle('@name?si=x'), 'name');
  assert.equal(extractHandle('@name#top'), 'name');
  assert.equal(extractHandle('https://www.youtube.com/@Name/videos'), 'Name');
  assert.equal(extractHandle('plainname'), 'plainname');
});

test('NFC merges composed and decomposed forms', () => {
  assert.equal(normalizeHandle('@Café'), normalizeHandle('@Café'));
});

test('normalizeEntries deduplicates and collects rejects', () => {
  const result = normalizeEntries({
    handles: ['@Drew', '@drew', '@DREW', '@Bad%ZZname', '@drewbinsky'],
    ids: ['UCaaaaaaaaaaaaaaaaaaaaaa', 'UCaaaaaaaaaaaaaaaaaaaaaa'],
  });
  assert.deepEqual([...result.handles], ['drew', 'drewbinsky']);
  assert.deepEqual([...result.ids], ['UCaaaaaaaaaaaaaaaaaaaaaa']);
  assert.deepEqual(result.rejected, ['@Bad%ZZname']);
});
