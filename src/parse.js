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
  const result = { handles: [], ids: [], rejected: [], entryLines: 0, declaredTotal: null };
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

const PARSERS = Object.freeze({
  'aislist-txt': parseAislistText,
});

/** Return the parser for a config `format` value, or throw for an unknown format. */
export function getParser(format) {
  if (!Object.hasOwn(PARSERS, format)) {
    throw new Error(`Unknown source format "${format}". Known formats: ${Object.keys(PARSERS).join(', ')}`);
  }
  return PARSERS[format];
}
