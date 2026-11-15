// Source list parsers. Each parser turns the raw text of one list file into
// raw entries; a source picks its parser through the `format` field of its config.

import { CHANNEL_ID_PATTERN } from './constants.js';

const TOTAL_CHANNELS_HEADER = /^total channels:\s*(\d+)$/i;
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * AiSList text format: one entry per line, `!` comment lines, blank lines skipped.
 * A line starting with `@` is a handle, a line matching the channel id pattern is
 * an id, anything else is a rejected line. The `! Total Channels: N` header is
 * read when present.
 *
 * Returns { handles, ids, rejected, entryLines, declaredTotal }, where
 * entryLines counts every non-blank, non-comment line.
 */
function parseAislistText(text, { commentPrefixes = ['!'] } = {}) {
  const result = emptyResult();
  for (const rawLine of text.replace(/^﻿/, '').split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (line === '') continue;

    const prefix = commentPrefixes.find((p) => line.startsWith(p));
    if (prefix !== undefined) {
      const header = TOTAL_CHANNELS_HEADER.exec(line.slice(prefix.length).trim());
      if (header) result.declaredTotal = Number(header[1]);
      continue;
    }

    result.entryLines += 1;
    if (line.startsWith('@')) result.handles.push(line);
    else if (CHANNEL_ID_PATTERN.test(line)) result.ids.push(line);
    else result.rejected.push(line);
  }
  return result;
}

/** A Spotify artist id: 22 base-62 characters. */
const SPOTIFY_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

const emptyResult = () => ({ handles: [], ids: [], names: [], rejected: [], entryLines: 0, declaredTotal: null });

/** An artist to find by name: `key` is stable across runs and sources, `name` is what to search for. */
const nameEntry = (name, spotify, fallbackKey) => ({ key: spotify ? `spotify:${spotify}` : fallbackKey, name, spotify });

/**
 * Soul Over AI `dist/artists.json`: an array of artists. A listed YouTube
 * channel id is kept as an id, and every artist is also a name to look up:
 * the listed id is usually the artist's own channel, while songs credit a
 * separate YouTube Music artist of the same name. Removed artists are skipped.
 */
function parseSoulOverAiJson(text) {
  const result = emptyResult();
  const artists = JSON.parse(text);
  if (!Array.isArray(artists)) throw new Error('soul-over-ai-json: expected an array of artists');
  for (const artist of artists) {
    if (artist?.removed === true) continue;
    result.entryLines += 1;
    const spotify = SPOTIFY_ID_PATTERN.test(artist?.spotify ?? '') ? artist.spotify : null;
    const name = typeof artist?.name === 'string' ? artist.name.trim() : '';
    const id = CHANNEL_ID_PATTERN.test(artist?.youtube ?? '') ? artist.youtube : null;
    if (id) result.ids.push(id);
    if (name !== '') result.names.push(nameEntry(name, spotify, `soul-over-ai:${artist.id}`));
    if (!id && name === '') result.rejected.push(JSON.stringify(artist?.id ?? artist));
  }
  return result;
}

/** Split one CSV line into fields, honouring double-quoted fields with `""` escapes. */
function splitCsvLine(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      fields.push(field);
      field = '';
    } else {
      field += c;
    }
  }
  if (quoted) return null;
  fields.push(field);
  return fields;
}

/**
 * CennoxX `SpotifyAiArtists.csv`: an `artist,id` header, then one Spotify
 * artist per line. Every row becomes a name to look up.
 */
function parseSpotifyArtistCsv(text) {
  const result = emptyResult();
  const lines = text.replace(/^\uFEFF/, '').split(LINE_BREAK);
  if ((lines[0] ?? '').trim().toLowerCase() !== 'artist,id') throw new Error('spotify-artist-csv: expected an "artist,id" header');
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    result.entryLines += 1;
    const fields = splitCsvLine(line);
    const name = fields?.[0]?.trim() ?? '';
    const spotify = fields?.[1]?.trim() ?? '';
    if (fields?.length === 2 && name !== '' && SPOTIFY_ID_PATTERN.test(spotify)) result.names.push(nameEntry(name, spotify));
    else result.rejected.push(line);
  }
  return result;
}

const PARSERS = Object.freeze({
  'aislist-txt': parseAislistText,
  'soul-over-ai-json': parseSoulOverAiJson,
  'spotify-artist-csv': parseSpotifyArtistCsv,
});

/** Return the parser for a config `format` value, or throw for an unknown format. */
export function getParser(format) {
  if (!Object.hasOwn(PARSERS, format)) {
    throw new Error(`Unknown source format "${format}". Known formats: ${Object.keys(PARSERS).join(', ')}`);
  }
  return PARSERS[format];
}
