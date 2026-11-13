import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getParser } from '../src/parse.js';

const parse = getParser('aislist-txt');

const SAMPLE = [
  '! Title: AISList - Blocklist',
  '! Format: One channel per line',
  '!',
  '! Total Channels: 5',
  '! Entries:',
  '@FirstChannel',
  '',
  '   ',
  '@Second-Channel',
  'UCabcdefghijklmnopqrstuv',
  'not a handle',
  '  @Padded  ',
].join('\n');

test('comments and blank lines are skipped', () => {
  const result = parse(SAMPLE);
  assert.equal(result.entryLines, 5);
});

test('handles, channel ids and junk lines are told apart', () => {
  const result = parse(SAMPLE);
  assert.deepEqual(result.handles, ['@FirstChannel', '@Second-Channel', '@Padded']);
  assert.deepEqual(result.ids, ['UCabcdefghijklmnopqrstuv']);
  assert.deepEqual(result.rejected, ['not a handle']);
});

test('a near-miss channel id is rejected', () => {
  const result = parse('UCabcdefghijklmnopqrstu\nUCabcdefghijklmnopqrstuvw\nucabcdefghijklmnopqrstuv');
  assert.deepEqual(result.ids, []);
  assert.equal(result.rejected.length, 3);
});

test('the Total Channels header is read', () => {
  assert.equal(parse(SAMPLE).declaredTotal, 5);
  assert.equal(parse('@a\n@b').declaredTotal, null);
  assert.equal(parse('!Total Channels:60455\n@a').declaredTotal, 60455);
});

test('CRLF and a leading BOM are handled', () => {
  const crlf = '﻿! Total Channels: 2\r\n@One\r\n\r\n@Two\r\n';
  const result = parse(crlf);
  assert.deepEqual(result.handles, ['@One', '@Two']);
  assert.equal(result.entryLines, 2);
  assert.equal(result.declaredTotal, 2);
});

test('extra comment prefixes are honoured when asked for', () => {
  const result = parse('# fix for issue 12\n! old note\n@Allowed', { commentPrefixes: ['!', '#'] });
  assert.deepEqual(result.handles, ['@Allowed']);
  assert.equal(result.entryLines, 1);
  assert.equal(parse('# not a comment here\n@x').rejected.length, 1);
});

test('unknown formats throw', () => {
  assert.throws(() => getParser('csv'), /Unknown source format "csv"/);
});
