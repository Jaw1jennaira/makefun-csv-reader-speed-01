// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
// Same answers as readCsv on every input, but built on indexOf jumps and
// String.split for the common plain line instead of one character at a time.
//
// Semantics (mirroring the reference exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside is one quote; each CRLF or lone CR inside is read as LF; what
//   follows its closing quote up to the next comma or line break is appended
//   as it stands (quote_junk when the field ends); a quote that never closes
//   is a literal character and the text after it is read again as unquoted
//   (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows hold the
//   records after it, each padded (short_row, fields: its count) or cut
//   (long_row, extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met; line is the 1-based
//   line its record starts on, row its record's index in rows (null for the
//   header); a record's short_row/long_row when it ends.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // Positions of every CR not followed by LF (a stray CR outside quotes, or
  // one inside a quoted field, whose line holds a quote anyway). Records are
  // read left to right, so one pointer into this sorted list tells whether
  // the current line holds one. A trailing CR of a CRLF is never listed.
  const stray = [];
  {
    let r = text.indexOf('\r', pos);
    while (r !== -1) {
      if (r + 1 >= len || text.charCodeAt(r + 1) !== 10) stray.push(r);
      r = text.indexOf('\r', r + 1);
    }
  }
  let strayIdx = 0;

  // The record being read: the line it starts on and its index in rows
  // (null for the header).
  let recordLine = 1;
  let recordRow = null;

  // The last field read by readQuoted/readJunk: its value and how it ended.
  let fVal = '';
  let fEnd = END;

  // Strips stray CRs from `v` (a slice that holds no LF, so every CR in it
  // is stray except a trailing one, which is the CRLF of the line break that
  // follows the slice). Returns the cleaned value.
  function stripStray(v, crlf) {
    let out = '';
    let p = 0;
    for (;;) {
      const r = v.indexOf('\r', p);
      if (r === -1) { out += v.slice(p); break; }
      out += v.slice(p, r);
      if (crlf && r === v.length - 1) break; // the CRLF's CR: dropped, no error
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      p = r + 1;
    }
    return out;
  }

  // Reads an unquoted field starting at pos, onto `value` (a quoted field's
  // value when reading junk after its closing quote). `lineEnd` is the index
  // of the next LF at or after pos, or len. Sets fVal/fEnd; returns the
  // number of characters kept (only the junk check uses it).
  function readJunk(value, lineEnd) {
    const c = text.indexOf(',', pos);
    if (c !== -1 && c < lineEnd) {
      let v = text.slice(pos, c);
      if (v.indexOf('\r') !== -1) v = stripStray(v, false);
      fVal = value + v;
      fEnd = COMMA;
      pos = c + 1;
      return v.length;
    }
    if (lineEnd >= len) {
      let v = text.slice(pos, len);
      if (v.indexOf('\r') !== -1) v = stripStray(v, false);
      fVal = value + v;
      fEnd = END;
      pos = len;
      return v.length;
    }
    let v = text.slice(pos, lineEnd);
    if (v.indexOf('\r') !== -1) v = stripStray(v, true);
    fVal = value + v;
    fEnd = LINE_BREAK;
    pos = lineEnd + 1;
    line += 1;
    return v.length;
  }

  // Converts CRLF and lone CR inside a quoted field to LF, counting the
  // line breaks. `s` holds no '"' that matters here (doubled quotes are
  // already unescaped before this runs).
  function crlfToLf(s) {
    let out = '';
    let p = 0;
    for (;;) {
      const r = s.indexOf('\r', p);
      const n = s.indexOf('\n', p);
      let e = s.length;
      let isCr = false;
      if (r !== -1 && r < e) { e = r; isCr = true; }
      if (n !== -1 && n < e) { e = n; isCr = false; }
      if (e === s.length) { out += s.slice(p); break; }
      out += s.slice(p, e);
      out += '\n';
      line += 1;
      p = isCr && e + 1 < s.length && s.charCodeAt(e + 1) === 10 ? e + 2 : e + 1;
    }
    return out;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fVal/fEnd.
  // `lineEnd` is the index of the next LF at or after pos, or len; the
  // caller refreshes it when the field runs past it.
  function readQuoted(lineEnd) {
    const open = pos;
    const openLine = line;
    pos += 1;
    // Find the closing quote: the next quote not followed by another quote.
    let q = text.indexOf('"', pos);
    let doubled = false;
    while (q !== -1 && q + 1 < len && text.charCodeAt(q + 1) === 34) {
      doubled = true;
      q = text.indexOf('"', q + 2);
    }
    if (q === -1) {
      // Never closes: the quote is literal, the text after it is read again
      // as unquoted. The line is rewound to the opening quote's line.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      const n2 = text.indexOf('\n', pos);
      readJunk('"', n2 === -1 ? len : n2);
      return;
    }
    // The quoted span is (open+1, q). Build its value. Only CR changes
    // inside quotes (CRLF and lone CR each read as one LF); a plain LF stays
    // as it is, so when the span holds no CR the slice is the value as it
    // stands — only the line number still needs the LFs counted, and only
    // when the field runs past the current line end.
    const seg = text.slice(open + 1, q);
    let value;
    if (seg.indexOf('\r') === -1) {
      value = doubled ? seg.replaceAll('""', '"') : seg;
      if (q > lineEnd) {
        let n = 0;
        let p = seg.indexOf('\n', 0);
        while (p !== -1) { n += 1; p = seg.indexOf('\n', p + 1); }
        line += n;
      }
    } else {
      value = crlfToLf(doubled ? seg.replaceAll('""', '"') : seg);
    }
    pos = q + 1;
    if (pos >= len) { fVal = value; fEnd = END; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { // ','
      pos += 1;
      fVal = value;
      fEnd = COMMA;
      return;
    }
    if (c === 10) { // LF
      pos += 1;
      line += 1;
      fVal = value;
      fEnd = LINE_BREAK;
      return;
    }
    if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) { // CRLF
      pos += 2;
      line += 1;
      fVal = value;
      fEnd = LINE_BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands.
    const le = text.indexOf('\n', pos);
    const added = readJunk(value, le === -1 ? len : le);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this record's first line holds no quote. A record only
    // spans lines through a quoted field, which needs a quote on its first
    // line, so a quote-free first line is the whole record. The quote check
    // stops at the first quote (frequent); the CR check only looks at the
    // line's last character plus a bounded scan of the line itself.
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let end = lineEnd;
    if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) end = lineEnd - 1;
    let fields = null;
    let quoted = false;
    const qi = text.indexOf('"', pos);
    while (strayIdx < stray.length && stray[strayIdx] < pos) strayIdx += 1;
    if ((qi === -1 || qi >= lineEnd) && (strayIdx >= stray.length || stray[strayIdx] >= end)) {
      // No quote, no stray CR on this line: one native split of the line.
      fields = text.slice(pos, end).split(',');
      pos = nl === -1 ? len : nl + 1;
      line += 1;
    }
    if (fields === null) {
      fields = [];
      let le = lineEnd;
      let ended;
      do {
        quoted = pos < len && text.charCodeAt(pos) === 34;
        if (quoted) {
          readQuoted(le);
          ended = fEnd;
          fields.push(fVal);
          if (pos > le) {
            const n2 = text.indexOf('\n', pos);
            le = n2 === -1 ? len : n2;
          }
        } else {
          // Unquoted field, bounded by the current line end. The stray-CR
          // pointer says whether this line holds one at all; when it does
          // not, the slice needs no CR check.
          while (strayIdx < stray.length && stray[strayIdx] < pos) strayIdx += 1;
          const hasStray = strayIdx < stray.length && stray[strayIdx] < le;
          const c = text.indexOf(',', pos);
          if (c !== -1 && c < le) {
            let v = text.slice(pos, c);
            if (hasStray && v.indexOf('\r') !== -1) v = stripStray(v, false);
            fields.push(v);
            pos = c + 1;
            ended = COMMA;
          } else if (le >= len) {
            let v = text.slice(pos, len);
            if (hasStray && v.indexOf('\r') !== -1) v = stripStray(v, false);
            fields.push(v);
            pos = len;
            ended = END;
          } else {
            let v = text.slice(pos, le);
            if (hasStray) {
              if (v.indexOf('\r') !== -1) v = stripStray(v, true);
            } else if (v.length > 0 && v.charCodeAt(v.length - 1) === 13) {
              v = v.slice(0, -1); // the CRLF's CR (not a stray, so the pointer missed it)
            }
            fields.push(v);
            pos = le + 1;
            line += 1;
            ended = LINE_BREAK;
          }
        }
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
