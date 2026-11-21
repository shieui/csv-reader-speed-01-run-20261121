// A fast drop-in for csv-reader 1.0.0 (make.fun): run(input) returns exactly
// what csv-reader returns for {text, header}: {columns, rows, errors}.
//
// Written from the RULES.txt spec, not from the reference source: one
// left-to-right pass over the text. Fields are cut out with slice() instead
// of built up a character at a time, and the scan only looks at each
// character once (charCodeAt), so the hot loop does no per-character
// allocation. Delimiters are checked by code (44 comma, 34 quote, 10 LF,
// 13 CR) to keep the comparisons cheap.
//
// Semantics, as the spec fixes them:
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field opening with a quote runs to the next quote that is not
//     doubled ("" inside is one quote); each CRLF or lone CR inside is read
//     as LF; what follows the closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows are
//     padded with "" (short_row, with fields: its field count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside a quoted
//     field counted), row its record's index in rows (null for the header).

// How a field ended: at a comma (the record goes on), at a line break or at
// the end of the text (the record ends).
const COMMA = 0;
const BREAK = 1;
const END = 2;

export function run(input) {
  const s = String(input.text);
  const header = input.header === true;
  const n = s.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && s.charCodeAt(0) === 0xFEFF) pos = 1;

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = s.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    // The record being read: the line it starts on and the index in rows it
    // takes (null: the header). Every error of this record carries these.
    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let ended = COMMA;
    let lastQuoted = false;

    do {
      let value = '';
      let needUnquoted = false;
      let junkMode = false;

      if (s.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        lastQuoted = true;
        const open = pos;
        const openLine = line;
        pos++;
        let seg = pos; // start of the current unflushed piece of the field
        let closed = false;
        while (pos < n) {
          const c = s.charCodeAt(pos);
          if (c === 34) {
            if (s.charCodeAt(pos + 1) === 34) {
              // Doubled quote: one quote in the field.
              value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
              value += '"';
              pos += 2;
              seg = pos;
            } else {
              // Closing quote.
              value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
              pos++;
              closed = true;
              break;
            }
          } else if (c === 13) {
            // CRLF and a lone CR inside quotes are each one LF.
            value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
            value += '\n';
            line++;
            pos++;
            if (s.charCodeAt(pos) === 10) pos++;
            seg = pos;
          } else if (c === 10) {
            value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
            value += '\n';
            line++;
            pos++;
            seg = pos;
          } else {
            pos++;
          }
        }
        if (!closed) {
          // The quote never closes: it is a literal character, and the text
          // after it is read again as unquoted.
          pos = open + 1;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          value = '"';
          needUnquoted = true;
        } else if (pos >= n) {
          fields.push(value);
          ended = END;
        } else {
          const c = s.charCodeAt(pos);
          if (c === 44) {
            fields.push(value);
            pos++;
            ended = COMMA;
          } else if (c === 10) {
            fields.push(value);
            pos++;
            line++;
            ended = BREAK;
          } else if (c === 13 && s.charCodeAt(pos + 1) === 10) {
            fields.push(value);
            pos += 2;
            line++;
            ended = BREAK;
          } else {
            // What follows the closing quote is appended as it stands, up to
            // the next comma or line break.
            needUnquoted = true;
            junkMode = true;
          }
        }
      } else {
        lastQuoted = false;
        needUnquoted = true;
      }

      if (needUnquoted) {
        // Reads unquoted characters onto `value` up to the next comma or
        // line break: a CR not followed by LF is dropped (stray_cr).
        // `added` counts the characters kept, for the quote_junk check.
        let added = 0;
        let seg = pos;
        let done = false;
        while (pos < n) {
          const c = s.charCodeAt(pos);
          if (c === 44) {
            value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
            added += pos - seg;
            pos++;
            ended = COMMA;
            done = true;
            break;
          }
          if (c === 10) {
            value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
            added += pos - seg;
            pos++;
            line++;
            ended = BREAK;
            done = true;
            break;
          }
          if (c === 13) {
            if (s.charCodeAt(pos + 1) === 10) {
              value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
              added += pos - seg;
              pos += 2;
              line++;
              ended = BREAK;
              done = true;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            value = value === '' ? s.slice(seg, pos) : value + s.slice(seg, pos);
            added += pos - seg;
            pos++;
            seg = pos;
            continue;
          }
          pos++;
        }
        if (!done) {
          value = value === '' ? s.slice(seg, n) : value + s.slice(seg, n);
          added += n - seg;
          pos = n;
          ended = END;
        }
        if (junkMode && added > 0) {
          errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        }
        fields.push(value);
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

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
