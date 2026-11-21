// A faster drop-in for csv-reader 1.0.0 (make.fun's reference CSV reader): run(input) returns exactly the answer
// csv-reader's readCsv returns for every input {text, header} — {columns, rows, errors} under csv-reader's
// broken-row policy — but reads the text with whole-field slices and index jumps instead of one character
// at a time.
//
// The policy, matched behaviour for behaviour:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not doubled, "" inside it one quote, and
//     each CRLF or lone CR inside it is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends); a quote that never closes is
//     read as a literal character and the text after it is read again as an unquoted field
//     (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay strings, never trimmed;
//   - columns is the first record when header is true, else null; rows holds the records after it (every
//     record when header is false), each padded with "" (short_row, with fields: its count) or cut
//     (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record starts on (every LF, CRLF and lone
//     CR inside a quoted field counted), row its record's index in rows (null for the header), in the order
//     met, a field's quote_junk when the field ends and a record's short_row or long_row when it ends.
//
// How it is faster: the record loop keeps its cursor in plain local variables and scans a plain field
// inline, taking it as one slice; quoted fields jump from quote to quote with indexOf; the pieces array a
// broken field needs is allocated only when the first stray CR or doubled quote is met. No state is kept
// between calls.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input, read faster. */
export function run(input) {
  const text = String(input.text);
  const t = text; // a second name for the record loop, which V8 keeps in a register
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read (the helpers' cursor)
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read by a helper: its value, how it ended, and how many characters an unquoted read kept.
  let fValue = '';
  let fEnded = END;
  let fAdded = 0;

  // Reads unquoted characters onto `init` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Sets fValue, fEnded and fAdded (the characters kept past `init`). The record loop
  // scans plain fields inline; this serves a quoted field's junk and unterminated reads.
  function readUnquoted(init) {
    let i = pos;
    let parts = null; // segments between stray CRs, allocated on the first one
    let seg = pos; // the start of the clean segment being scanned
    let added = 0;
    let ended = END;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        ended = COMMA;
        break;
      }
      if (c === 10) {
        ended = BREAK;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          ended = BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) parts = [init];
        parts.push(text.slice(seg, i));
        added += i - seg;
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    if (parts === null) {
      fValue = init === '' ? text.slice(pos, i) : init + text.slice(pos, i);
      fAdded = i - pos;
    } else {
      parts.push(text.slice(seg, i));
      fValue = parts.join('');
      fAdded = added + (i - seg);
    }
    fEnded = ended;
    if (ended === COMMA) {
      pos = i + 1;
    } else if (ended === BREAK) {
      pos = text.charCodeAt(i) === 13 ? i + 2 : i + 1;
      line += 1;
    } else {
      pos = i;
    }
  }

  // The raw text in [a, b) inside a quoted field, read as the field keeps it: each CRLF or lone CR becomes
  // one LF. Returns the kept text in sValue; sLines counts the line breaks it holds.
  let sValue = '';
  let sLines = 0;
  function segment(a, b) {
    const s = text.slice(a, b);
    let out = s;
    if (s.indexOf('\r') !== -1) out = s.replace(/\r\n|\r/g, '\n');
    sValue = out;
    let count = 0;
    let k = out.indexOf('\n');
    while (k !== -1) {
      count += 1;
      k = out.indexOf('\n', k + 1);
    }
    sLines = count;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fValue and fEnded.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let i = open + 1;
    let seg = i; // the start of the raw segment being scanned
    let parts = null; // value pieces, allocated on the first doubled quote
    let qline = line; // the line count inside the quotes, committed only when the field closes
    let closed = false;
    let closePos = -1;
    for (;;) {
      const q = text.indexOf('"', i);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: the segment before it and one literal quote join the value.
        segment(seg, q);
        qline += sLines;
        if (parts === null) parts = [];
        parts.push(sValue, '"');
        i = q + 2;
        seg = i;
        continue;
      }
      closed = true;
      closePos = q;
      segment(seg, q);
      qline += sLines;
      if (parts === null) {
        fValue = sValue;
      } else {
        parts.push(sValue);
        fValue = parts.join('');
      }
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      readUnquoted('"');
      return;
    }
    line = qline;
    pos = closePos + 1;
    if (pos >= n) {
      fEnded = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = BREAK;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = BREAK;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    readUnquoted(fValue);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // The record loop, on its own cursor (p, ln): the helpers' pos/line are synced only around a quoted field.
  let p = pos;
  let ln = line;
  while (true) {
    // Lines with no characters are no records.
    while (p < n) {
      const c = t.charCodeAt(p);
      if (c === 10) {
        p += 1;
        ln += 1;
      } else if (c === 13 && t.charCodeAt(p + 1) === 10) {
        p += 2;
        ln += 1;
      } else {
        break;
      }
    }
    if (p >= n) break;

    recordLine = ln;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let ended = END;
    do {
      if (t.charCodeAt(p) === 34) {
        quoted = true;
        pos = p;
        line = ln;
        readQuoted();
        p = pos;
        ln = line;
        fields.push(fValue);
        ended = fEnded;
      } else {
        quoted = false;
        // A plain field, scanned inline: whole, as one slice, unless a stray CR breaks it into pieces.
        let i = p;
        let seg = p;
        let parts = null;
        let e = END;
        while (i < n) {
          const c = t.charCodeAt(i);
          if (c > 44) {
            // Letters, digits and most punctuation: never a field or record end.
            i += 1;
            continue;
          }
          if (c === 44) {
            e = COMMA;
            break;
          }
          if (c === 10) {
            e = BREAK;
            break;
          }
          if (c === 13) {
            if (t.charCodeAt(i + 1) === 10) {
              e = BREAK;
              break;
            }
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
            if (parts === null) parts = [];
            parts.push(t.slice(seg, i));
            i += 1;
            seg = i;
            continue;
          }
          i += 1;
        }
        if (parts === null) {
          fields.push(t.slice(p, i));
        } else {
          parts.push(t.slice(seg, i));
          fields.push(parts.join(''));
        }
        if (e === COMMA) {
          p = i + 1;
        } else if (e === BREAK) {
          p = t.charCodeAt(i) === 13 ? i + 2 : i + 1;
          ln += 1;
        } else {
          p = i;
        }
        ended = e;
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
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
