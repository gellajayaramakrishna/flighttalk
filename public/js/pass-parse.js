/*
 * FlightTalk boarding-pass parsing (runs in the browser AND in Node for tests).
 *
 * Two independent sources of truth:
 *   1. parseBCBP(text)    -> the barcode on every boarding pass (IATA Resolution 792,
 *                            "Bar Coded Boarding Pass"). Fixed-width fields, very reliable.
 *   2. parseOcrText(text) -> fallback when there is no readable barcode: pulls the
 *                            name / flight / seat out of noisy Tesseract output.
 *
 * Nothing here talks to the network. The boarding-pass image never leaves the device.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FTParse = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TITLES = ['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MASTER', 'DR', 'PROF', 'CHD', 'INF', 'MX'];
  const TITLE_RE = new RegExp(`\\s+(?:${TITLES.join('|')})\\.?$`);

  // Words that commonly sit near the name on a printed pass but are never part of it.
  const STOPWORDS = new Set([
    'BOARDING', 'PASS', 'NAME', 'PASSENGER', 'FLIGHT', 'SEAT', 'GATE', 'CLASS', 'DATE',
    'FROM', 'TO', 'DEPARTURE', 'ARRIVAL', 'TIME', 'ZONE', 'GROUP', 'SEQ', 'SEQUENCE',
    'PNR', 'BOOKING', 'REF', 'ECONOMY', 'BUSINESS', 'FIRST', 'TERMINAL', 'BOARDS',
    'CLOSES', 'AIRLINES', 'AIRWAYS', 'AIR', 'INDIA', 'INDIGO', 'ETKT', 'TICKET', 'CABIN'
  ]);

  // Common carrier codes. Used only to *rank* OCR flight-number candidates.
  const KNOWN_CARRIERS = new Set([
    'AI', '6E', 'UK', 'SG', 'QP', 'IX', 'I5', 'G8', '9I', 'S5', 'EK', 'QR', 'EY', 'SQ',
    'BA', 'LH', 'AF', 'KL', 'TK', 'UA', 'AA', 'DL', 'CX', 'TG', 'MH', 'GF', 'WY', 'SV',
    'FZ', 'G9', 'UL', 'NH', 'JL', 'KE', 'OZ', 'QF', 'NZ', 'AC', 'LX', 'OS', 'VS', 'EI',
    'U2', 'FR', 'W6', 'AK', 'TR', '3K', 'VJ', 'BG', 'KU', 'ET', 'MS', 'SA', 'KQ'
  ]);

  const VALID_SEAT_LETTERS = 'ABCDEFGHJK'; // "I" is never used for seats.

  function clean(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function lettersOnly(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  }

  /** Normalise a seat like "012A", "12 A", "12a" -> "12A". Returns '' if impossible. */
  function normalizeSeat(raw) {
    const m = String(raw || '').toUpperCase().replace(/\s+/g, '').match(/^0*(\d{1,2})([A-Z])$/);
    if (!m) return '';
    const row = Number(m[1]);
    if (row < 1 || row > 99) return '';
    if (!VALID_SEAT_LETTERS.includes(m[2])) return '';
    return `${row}${m[2]}`;
  }

  /** Normalise "AI 0865", "AI865", "6E-123" -> "AI865" / "6E123". */
  function normalizeFlight(carrier, number, suffix) {
    const c = String(carrier || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const n = String(number || '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    const s = String(suffix || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
    if (c.length < 2 || c.length > 3 || !n || n.length > 4) return '';
    return `${c}${n}${s}`;
  }

  /** "GELLA/JAYARAMA KRISHNA MR" -> { surname, given, full } */
  function splitName(raw) {
    let s = clean(String(raw || '').toUpperCase().replace(/[^A-Z/ '\-]/g, ' '));
    s = s.replace(TITLE_RE, '');
    let surname = '';
    let given = '';
    if (s.includes('/')) {
      const idx = s.indexOf('/');
      surname = clean(s.slice(0, idx));
      given = clean(s.slice(idx + 1)).replace(TITLE_RE, '');
    } else {
      const parts = s.split(' ').filter(Boolean);
      if (parts.length >= 2) {
        // Printed "MR JAYARAMA KRISHNA GELLA" style: last word is the surname.
        surname = parts[parts.length - 1];
        given = parts.slice(0, -1).join(' ');
      } else {
        given = parts[0] || '';
      }
    }
    surname = surname.replace(/^(?:MR|MRS|MS|MISS|DR)\s+/, '');
    given = given.replace(/^(?:MR|MRS|MS|MISS|DR|MSTR)\s+/, '');
    if (!surname && !given) return null;
    const full = surname && given ? `${surname}/${given}` : (surname || given);
    return { surname, given, full };
  }

  /**
   * Display-name suggestion: first 3 letters of the first given name
   * (or the whole name if it is 3 letters or fewer). Mirrors the original
   * FlightTalk privacy rule.
   */
  function suggestDisplayName(name) {
    if (!name) return '';
    const first = lettersOnly((name.given || name.surname || '').split(' ')[0]);
    if (!first) return '';
    const s = first.length <= 3 ? first : first.slice(0, 3);
    return s.charAt(0) + s.slice(1).toLowerCase();
  }

  /**
   * Identity key used to recognise "same passenger, new device".
   * BCBP truncates names to 20 chars, OCR usually gets the whole thing,
   * so both paths are reduced to the first 12 letters of SURNAME+GIVEN.
   */
  function identityKey(name) {
    if (!name) return '';
    return lettersOnly(`${name.surname}${name.given}`).slice(0, 12);
  }

  // ---------------------------------------------------------------------------
  // 1. IATA BCBP (barcode) parser
  // ---------------------------------------------------------------------------

  function julianToDate(julian, refDate) {
    const n = Number(julian);
    if (!Number.isInteger(n) || n < 1 || n > 366) return null;
    const ref = refDate || new Date();
    // Pick the year that makes the date closest to "now" (passes are used within days).
    let best = null;
    for (const y of [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1]) {
      const d = new Date(Date.UTC(y, 0, 1));
      d.setUTCDate(n);
      const diff = Math.abs(d - ref);
      if (!best || diff < best.diff) best = { d, diff };
    }
    return best.d.toISOString().slice(0, 10);
  }

  /**
   * Parse IATA BCBP "M" format. Layout of the mandatory part of leg 1 (60 chars):
   *   0     format code 'M'
   *   1     number of legs
   *   2-21  passenger name (20)       SURNAME/GIVEN
   *   22    e-ticket indicator
   *   23-29 PNR (7)
   *   30-32 from airport (3)
   *   33-35 to airport (3)
   *   36-38 operating carrier (3)
   *   39-43 flight number (5)         NNNNa
   *   44-46 julian date of flight (3)
   *   47    compartment code
   *   48-51 seat (4)                  NNNa
   *   52-56 check-in sequence (5)
   *   57    passenger status
   *   58-59 size of conditional section (hex)
   * Every following leg repeats fields 23..59 (37 chars) after the previous conditional block.
   */
  function parseBCBP(input, opts) {
    const text = String(input || '').replace(/[\r\n]+$/g, '');
    if (text.length < 58 || text[0] !== 'M') return null;
    const legCount = Number(text[1]);
    if (!Number.isInteger(legCount) || legCount < 1 || legCount > 4) return null;

    const name = splitName(text.slice(2, 22));
    const eticket = text[22] === 'E';
    const legs = [];
    let cursor = 23;

    for (let i = 0; i < legCount; i += 1) {
      if (text.length < cursor + 35) break;
      const pnr = clean(text.slice(cursor, cursor + 7));
      const from = clean(text.slice(cursor + 7, cursor + 10));
      const to = clean(text.slice(cursor + 10, cursor + 13));
      const carrier = clean(text.slice(cursor + 13, cursor + 16));
      const fnRaw = text.slice(cursor + 16, cursor + 21);
      const julian = clean(text.slice(cursor + 21, cursor + 24));
      const compartment = text.slice(cursor + 24, cursor + 25).trim();
      const seatRaw = clean(text.slice(cursor + 25, cursor + 29));
      const sequence = clean(text.slice(cursor + 29, cursor + 34)).replace(/^0+(?=\d)/, '');
      const status = text.slice(cursor + 34, cursor + 35);
      const condSize = parseInt(text.slice(cursor + 35, cursor + 37), 16);

      const fm = fnRaw.match(/^\s*(\d{1,4})\s*([A-Z]?)\s*$/);
      legs.push({
        pnr,
        from,
        to,
        carrier,
        flight: fm ? normalizeFlight(carrier, fm[1], fm[2]) : '',
        julianDate: julian,
        date: julianToDate(julian, opts && opts.refDate),
        compartment,
        seat: normalizeSeat(seatRaw),
        sequence,
        status
      });
      cursor += 37 + (Number.isFinite(condSize) ? condSize : 0);
    }

    if (!legs.length) return null;
    const leg = legs[0];
    if (!leg.flight || !/^[A-Z]{3}$/.test(leg.from) || !/^[A-Z]{3}$/.test(leg.to)) return null;

    return {
      source: 'barcode',
      name,
      eticket,
      legs,
      flight: leg.flight,
      seat: leg.seat, // may be '' for "INF", "GATE" etc.
      from: leg.from,
      to: leg.to,
      pnr: leg.pnr,
      date: leg.date,
      julianDate: leg.julianDate,
      compartment: leg.compartment,
      confidence: { name: name ? 1 : 0, flight: 1, seat: leg.seat ? 1 : 0 }
    };
  }

  /** Pick the leg that matches the flight this aircraft is operating (multi-leg passes). */
  function pickLeg(parsed, cabinFlight) {
    if (!parsed || !parsed.legs || !cabinFlight) return parsed;
    const leg = parsed.legs.find((l) => l.flight === cabinFlight);
    if (!leg) return parsed;
    return Object.assign({}, parsed, {
      flight: leg.flight, seat: leg.seat, from: leg.from, to: leg.to,
      pnr: leg.pnr, date: leg.date, julianDate: leg.julianDate, compartment: leg.compartment
    });
  }

  // ---------------------------------------------------------------------------
  // 2. OCR fallback parser
  // ---------------------------------------------------------------------------

  // Fix the usual Tesseract confusions inside a token that should be digits.
  function digitsFix(s) {
    return String(s).replace(/[OQD]/g, '0').replace(/[IL|!]/g, '1').replace(/S/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
  }

  // ...and inside the letter of a seat ("29)" -> "29J", "128" -> "12B").
  function seatFix(token) {
    const t = String(token || '').toUpperCase().replace(/\s+/g, '');
    if (t.length < 2) return '';
    const letter = { ')': 'J', ']': 'J', '}': 'J', '8': 'B', '(': 'C', '€': 'E', '0': 'D' }[t.slice(-1)] || t.slice(-1);
    return normalizeSeat(digitsFix(t.slice(0, -1)) + letter);
  }

  function isPlausibleNameWord(w) {
    return /^[A-Z][A-Z'\-]{0,24}$/.test(w) && !STOPWORDS.has(w) && !TITLES.includes(w);
  }

  function nameFromCandidate(raw) {
    const n = splitName(raw);
    if (!n) return null;
    const words = `${n.surname} ${n.given}`.split(/\s+/).filter(Boolean);
    if (!words.length || !words.every(isPlausibleNameWord)) return null;
    if (lettersOnly(n.full).length < 3) return null;
    return n;
  }

  function findName(lines) {
    // a) "SURNAME/GIVEN" anywhere. OCR often turns "/" into "|", "l", "1" or "I".
    for (const line of lines) {
      const fixed = line.replace(/\s*[|\\]\s*/g, '/');
      const m = fixed.match(/\b([A-Z][A-Z'\-]{1,24}(?: [A-Z][A-Z'\-]{1,24})?)\s*\/\s*([A-Z][A-Z'\-]{0,24}(?: [A-Z][A-Z'\-]{0,24}){0,3})\b/);
      if (m) {
        const n = nameFromCandidate(`${m[1]}/${m[2]}`);
        if (n) return { name: n, score: 0.95 };
      }
    }
    // b) A "NAME" / "PASSENGER" label, value on the same line or the next one.
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lm = line.match(/\b(?:NAME OF PASSENGER|PASSENGER NAME|PASSENGER|NAME)\b\s*[:.\-]?\s*(.*)$/);
      if (!lm) continue;
      const candidates = [lm[1], lines[i + 1] || ''];
      for (const c of candidates) {
        // Cut the value off where the next label starts (labels are often on one row).
        const value = c.split(/\b(?:FLIGHT|SEAT|GATE|FROM|DATE|CLASS|PNR|BOARDING)\b/)[0];
        const n = nameFromCandidate(value);
        if (n) return { name: n, score: 0.8 };
      }
    }
    // c) No label survived OCR, but a line reads like "MS PRIYA BOSE" (title + 2-4 words).
    for (const line of lines) {
      const m = line.match(/^(?:MR|MRS|MS|MISS|MSTR|DR)\.? ((?:[A-Z][A-Z'\-]+ ){1,3}[A-Z][A-Z'\-]+)$/);
      if (m) {
        const n = nameFromCandidate(m[1]);
        if (n) return { name: n, score: 0.6 };
      }
    }
    return { name: null, score: 0 };
  }

  // --- Label row / value row pairing ------------------------------------------
  // Most passes print a row of labels ("FLIGHT FROM TO GATE SEAT") with the values
  // underneath. OCR keeps the order but loses the columns, so pair them by position.
  const FIELD_LABELS = {
    FLIGHT: 'flight', FLT: 'flight', SEAT: 'seat', GATE: 'gate', FROM: 'from', TO: 'to',
    DATE: 'date', CLASS: 'class', ZONE: 'zone', GROUP: 'group', TERMINAL: 'terminal',
    DEPARTURE: 'dep', DEP: 'dep', ARRIVAL: 'arr', SEQ: 'seq', BOARDING: 'boarding', TIME: 'time', CABIN: 'class'
  };

  function editDistance1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i += 1; j += 1; continue; }
      edits += 1;
      if (edits > 1) return false;
      if (a.length > b.length) i += 1;
      else if (b.length > a.length) j += 1;
      else { i += 1; j += 1; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }

  function asLabel(token) {
    const t = token.replace(/[^A-Z]/g, '');
    if (FIELD_LABELS[t]) return FIELD_LABELS[t];
    if (t.length >= 3) {
      for (const key of Object.keys(FIELD_LABELS)) if (key.length >= 4 && editDistance1(t, key)) return FIELD_LABELS[key];
    }
    return null;
  }

  function labelLine(line) {
    const toks = line.split(' ').filter(Boolean);
    if (!toks.length || toks.length > 8) return null;
    const labels = toks.map(asLabel);
    return labels.every(Boolean) ? labels : null;
  }

  function valueTokens(line) {
    const spaced = line.replace(/(\d)([A-Z]{3})\b/g, '$1 $2').replace(/\b([A-Z]{3})(\d)/g, '$1 $2');
    const raw = spaced.split(' ').filter(Boolean);
    const out = [];
    for (let i = 0; i < raw.length; i += 1) {
      const t = raw[i];
      const next = raw[i + 1];
      // Merge "QR" "2392" / "6E" "651" / "Al" "865" into one flight token.
      if (/^(?:[A-Z]{2}|[A-Z]\d|\d[A-Z]|A[L1])$/.test(t) && next && /^[0-9OIQDSLB]{2,4}$/.test(next) && /\d/.test(next)) {
        out.push(`${t} ${next}`);
        i += 1;
      } else out.push(t);
    }
    return out;
  }

  function pairColumns(lines) {
    const pairs = {};
    for (let i = 0; i < lines.length; i += 1) {
      let labels = labelLine(lines[i]);
      if (!labels) continue;
      let j = i + 1;
      // A label row that OCR split over several lines ("FLIGHT FROM GATE SEAT" + "TO") has unreliable
      // column order. One label per line (sparse-text mode) or a single row is fine.
      let multi = labels.length > 1;
      let rows = 1;
      while (j < lines.length && labelLine(lines[j])) {
        const more = labelLine(lines[j++]);
        multi = multi || more.length > 1;
        rows += 1;
        labels = labels.concat(more);
      }
      const wrapped = multi && rows > 1;
      const values = [];
      for (let k = j; k < lines.length && k < j + 8 && values.length < labels.length + 2; k += 1) {
        if (labelLine(lines[k]) || /\b(?:PNR|NAME|PASSENGER)\b/.test(lines[k])) break;
        values.push(...valueTokens(lines[k]));
      }
      if (!values.length) continue;
      const exact = values.length === labels.length;
      labels.forEach((label, idx) => {
        // Equal counts: pair 1:1. Otherwise trust the first half from the left, the rest from the right.
        const v = exact ? values[idx] : (idx < labels.length / 2 ? values[idx] : values[values.length - (labels.length - idx)]);
        const score = wrapped ? (idx === 0 ? 0.85 : 0.5) : (exact ? 0.9 : 0.7);
        if (v && !pairs[label]) pairs[label] = { value: v, score };
      });
      i = j - 1;
    }
    return pairs;
  }

  function findFlight(text, lines, pairs) {
    if (pairs && pairs.flight) {
      const m = pairs.flight.value.match(/^([A-Z]{2}|[A-Z]\d|\d[A-Z]|A[L1]) ?([0-9OIQDSLB]{1,4})$/);
      if (m) {
        const carrier = /^A[L1]$/.test(m[1]) ? 'AI' : m[1];
        const f = normalizeFlight(carrier, digitsFix(m[2]));
        if (f) return { flight: f, score: pairs.flight.score };
      }
    }
    const candidates = [];
    const re = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?[-\s]?\s?([0-9OIQDSLB|]{2,4})(?![0-9])/g;
    lines.forEach((line, li) => {
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) {
        const number = digitsFix(m[2]);
        if (!/^\d{2,4}$/.test(number)) continue;
        let carrier = m[1];
        // OCR often reads "AI" as "Al" / "A1".
        if (/^A[L1]$/.test(carrier)) carrier = 'AI';
        let score = 0.3;
        if (KNOWN_CARRIERS.has(carrier)) score += 0.35;
        const context = `${lines[li - 1] || ''} ${line}`;
        if (/\bFLIGHT|\bFLT\b/.test(context)) score += 0.35;
        if (/\bSEAT|\bGATE|\bTERMINAL|\bZONE/.test(line.slice(Math.max(0, m.index - 6), m.index))) score -= 0.3;
        candidates.push({ flight: normalizeFlight(carrier, number), score });
      }
    });
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates.find((c) => c.flight);
    return best ? { flight: best.flight, score: Math.min(1, best.score) } : { flight: '', score: 0 };
  }

  function findSeat(text, lines, pairs) {
    // a) Labelled: "SEAT 12A", "SEAT: 012A", "SEAT\n12A"
    for (let i = 0; i < lines.length; i += 1) {
      const m0 = lines[i].match(/\bSEAT(?:\s*NO\.?)?\s*[:.\-]\s*([0-9OIQDSLB|]{1,3}\s?[A-K])\b/);
      if (m0) {
        const seat = normalizeSeat(digitsFix(m0[1].slice(0, -1)) + m0[1].slice(-1));
        if (seat) return { seat, score: 0.95 };
      }
    }
    // b) Label row / value row
    if (pairs && pairs.seat) {
      const seat = seatFix(pairs.seat.value);
      if (seat) return { seat, score: pairs.seat.score };
    }
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/\bSEAT(?:\s*NO\.?)?\s*[:.\-]?\s*([0-9OIQDSLB|]{1,3}\s?[A-K])\b/);
      if (m) {
        const seat = normalizeSeat(digitsFix(m[1].slice(0, -1)) + m[1].slice(-1));
        if (seat) return { seat, score: 0.95 };
      }
      if (/\bSEAT\b/.test(lines[i]) && lines[i + 1]) {
        // Labels row then values row: take the value in a similar column.
        const labelCol = lines[i].indexOf('SEAT');
        const tokens = [...lines[i + 1].matchAll(/\b(\d{1,3}\s?[A-K])\b/g)];
        tokens.sort((a, b) => Math.abs(a.index - labelCol) - Math.abs(b.index - labelCol));
        for (const t of tokens) {
          const seat = normalizeSeat(t[1]);
          if (seat) return { seat, score: 0.75 };
        }
      }
    }
    // b) Unlabelled: any "12A" that is not obviously a gate / terminal.
    const re = /\b(\d{1,2})\s?([A-HJK])\b(?!\s?\d)/g;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 8), m.index);
      if (/GATE|TERMINAL|\bT\s?$|ZONE|GROUP/.test(before)) continue;
      const seat = normalizeSeat(`${m[1]}${m[2]}`);
      if (seat) return { seat, score: 0.45 };
    }
    return { seat: '', score: 0 };
  }

  function findAirports(lines) {
    for (const line of lines) {
      const m = line.match(/\bFROM\b\s*[:.\-]?\s*([A-Z]{3})\b.*?\bTO\b\s*[:.\-]?\s*([A-Z]{3})\b/);
      if (m) return { from: m[1], to: m[2] };
      const arrow = line.match(/\b([A-Z]{3})\s*(?:-|>|→|TO)\s*([A-Z]{3})\b/);
      if (arrow && !STOPWORDS.has(arrow[1]) && !STOPWORDS.has(arrow[2])) return { from: arrow[1], to: arrow[2] };
    }
    return { from: '', to: '' };
  }

  function parseOcrText(raw) {
    const text = String(raw || '').toUpperCase().replace(/[‘’]/g, "'");
    const lines = text.split(/\r?\n/).map((l) => l.replace(/[^\x20-\x7E→]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const joined = lines.join('\n');
    const pairs = pairColumns(lines);
    const n = findName(lines);
    const f = findFlight(joined, lines, pairs);
    const s = findSeat(joined, lines, pairs);
    const a = findAirports(lines);
    return {
      source: 'ocr',
      name: n.name,
      flight: f.flight,
      seat: s.seat,
      from: a.from,
      to: a.to,
      pnr: '',
      date: null,
      confidence: { name: n.score, flight: f.score, seat: s.score }
    };
  }

  /** The original regex the project used, kept only so the benchmark can compare. */
  function legacyOcrParse(raw) {
    const text = String(raw || '').toUpperCase();
    const flight = text.match(/\b([A-Z0-9]{2,3}\s*\d{3,4})\b/);
    const seat = text.match(/\b(\d{1,3}[A-K])\b/);
    return {
      name: null,
      flight: flight ? flight[1].replace(/\s+/g, '').replace(/^A[L1](?=\d)/, 'AI') : '',
      seat: seat ? seat[1] : ''
    };
  }

  return {
    parseBCBP,
    parseOcrText,
    legacyOcrParse,
    pickLeg,
    splitName,
    suggestDisplayName,
    identityKey,
    normalizeSeat,
    normalizeFlight
  };
}));
