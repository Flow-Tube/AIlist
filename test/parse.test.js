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

test('soul-over-ai-json keeps youtube ids and looks every artist up by name', () => {
  const parse = getParser('soul-over-ai-json');
  const spotify = 'a'.repeat(22);
  const result = parse(
    JSON.stringify([
      { id: 'one', name: ' One ', removed: false, spotify, youtube: 'UCoooooooooooooooooooooo' },
      { id: 'two', name: 'Two', removed: false, spotify: null, youtube: 'not-an-id' },
      { id: 'gone', name: 'Gone', removed: true, spotify, youtube: 'UCgggggggggggggggggggggg' },
      { id: 'empty', name: '', removed: false, spotify: null, youtube: null },
    ]),
  );
  assert.deepEqual(result.ids, ['UCoooooooooooooooooooooo']);
  assert.deepEqual(result.names, [
    { key: `spotify:${spotify}`, name: 'One', spotify },
    { key: 'soul-over-ai:two', name: 'Two', spotify: null },
  ]);
  assert.equal(result.entryLines, 3);
  assert.equal(result.rejected.length, 1);
  assert.throws(() => parse('{}'), /array/);
});

test('spotify-artist-csv reads quoted names and rejects rows without a Spotify id', () => {
  const parse = getParser('spotify-artist-csv');
  const b = 'b'.repeat(22);
  const c = 'c'.repeat(22);
  const result = parse(`artist,id\r\nPlain Name,${b}\n"Comma, ""Quoted"" Band",${c}\nno id here\n,${b}\n\n`);
  assert.deepEqual(result.names, [
    { key: `spotify:${b}`, name: 'Plain Name', spotify: b },
    { key: `spotify:${c}`, name: 'Comma, "Quoted" Band', spotify: c },
  ]);
  assert.equal(result.entryLines, 4);
  assert.deepEqual(result.rejected, ['no id here', `,${b}`]);
  assert.throws(() => parse('name,spotify\n'), /header/);
});
