'use strict';

// The few pieces of Python semantics the loop evaluator depends on, so the Node port gives the
// same verdict as the Python reference (tools/skills/loop_eval.py in the project it came from):
// - JSON with Python's int/float distinction (1 vs 1.0) and its error messages,
// - Python's whitespace, line splitting, strip() and digit rules (str patterns are Unicode-aware),
// - == between JSON values (True == 1, 1 == 1.0), truthiness, set membership, repr() for messages.
// Python objects are modelled as: null, boolean, int (number or bigint), PyFloat, string, Array, Map.

/** Characters for which Python's str.isspace() is true (also what `\s` matches in a str pattern). */
const WS_CHARS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const WS = `[${WS_CHARS}]`;
const WS_EDGE = new RegExp(`^${WS}+|${WS}+$`, 'gu');

class PyFloat {
  constructor(value) {
    this.value = value;
  }
}
const NAN = new PyFloat(NaN); // Python's json returns one shared NaN object

/** Python str.strip() with no argument. */
function strip(s) {
  return s.replace(WS_EDGE, '');
}

/** Python str.splitlines() (no keepends). */
function splitlines(s) {
  if (s === '') return [];
  const parts = s.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/u);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** Text as Python's open(path, encoding="utf-8").read() returns it: strict UTF-8, BOM kept, universal newlines. */
function decodeText(buf) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  return text.replace(/\r\n?/g, '\n');
}

const ND = /\p{Nd}/u;
/** int() of a string of Unicode decimal digits (what Python's `\d+` matches). Nd digits come in runs of 0-9. */
function digitsToInt(s) {
  let n = 0n;
  for (const ch of s) {
    let cp = ch.codePointAt(0);
    let zero = cp;
    while (ND.test(String.fromCodePoint(zero - 1))) zero--;
    n = n * 10n + BigInt((cp - zero) % 10);
  }
  return n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
}

const isInt = (v) => typeof v === 'number' || typeof v === 'bigint';
const isDict = (v) => v instanceof Map;

/** Plain JS data to the Python model (idempotent): objects become Maps, non-integral numbers PyFloats. */
function toPy(v) {
  if (v === undefined) return null;
  if (v === null || typeof v === 'boolean' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? (Object.is(v, -0) ? 0 : v) : new PyFloat(v);
  if (v instanceof PyFloat) return v;
  if (Array.isArray(v)) return v.map(toPy);
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, toPy(x)]));
  return new Map(Object.entries(v).map(([k, x]) => [k, toPy(x)]));
}

function numeric(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isInt(v)) return v;
  if (v instanceof PyFloat) return v.value;
  return undefined;
}

/** Python `a == b` for JSON values. Inside containers Python also short-cuts on identity. */
function eq(a, b, top = true) {
  if (!top && a === b) return true;
  const na = numeric(a);
  const nb = numeric(b);
  if (na !== undefined || nb !== undefined) return na !== undefined && nb !== undefined && na == nb; // eslint-disable-line eqeqeq
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eq(x, b[i], false));
  if (isDict(a) && isDict(b)) {
    if (a.size !== b.size) return false;
    for (const [k, x] of a) if (!b.has(k) || !eq(x, b.get(k), false)) return false;
    return true;
  }
  return false;
}

/** Python bool(v). */
function truthy(v) {
  if (v === null || v === false) return false;
  if (v === true) return true;
  if (isInt(v)) return v != 0; // eslint-disable-line eqeqeq
  if (v instanceof PyFloat) return v.value !== 0;
  if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return v.size > 0;
  return true;
}

/** A key that is equal for values Python's set would treat as one element; undefined if unhashable. */
function hashKey(v) {
  if (typeof v === 'string') return 's' + v;
  if (v === null) return 'n';
  const n = numeric(v);
  if (n === undefined) return undefined; // list or dict: unhashable in Python
  if (typeof n === 'number' && !Number.isInteger(n)) return 'f' + String(n);
  return 'i' + BigInt(n).toString();
}

/** Compare strings by code point, as Python sorts str (JS sorts by UTF-16 unit). */
function cmpStr(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

const NONPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
const hex = (cp, width) => cp.toString(16).padStart(width, '0');

function reprStr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + hex(cp, 2);
    else if (cp < 0x7f || ch === ' ' || !NONPRINTABLE.test(ch)) out += ch;
    else if (cp <= 0xff) out += '\\x' + hex(cp, 2);
    else if (cp <= 0xffff) out += '\\u' + hex(cp, 4);
    else out += '\\U' + hex(cp, 8);
  }
  return out + q;
}

function reprFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const sign = x < 0 ? '-' : '';
  const [mant, e] = Math.abs(x).toExponential().split('e');
  const digits = mant.replace('.', '');
  const exp = Number(e);
  const decpt = exp + 1;
  let body;
  if (decpt > -4 && decpt <= 16) {
    if (decpt <= 0) body = '0.' + '0'.repeat(-decpt) + digits;
    else if (decpt >= digits.length) body = digits + '0'.repeat(decpt - digits.length) + '.0';
    else body = digits.slice(0, decpt) + '.' + digits.slice(decpt);
  } else {
    body = digits[0] + (digits.length > 1 ? '.' + digits.slice(1) : '') + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  }
  return sign + body;
}

/** Python repr() of a JSON value (used in violation messages). */
function repr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (isInt(v)) return String(v);
  if (v instanceof PyFloat) return reprFloat(v.value);
  if (typeof v === 'string') return reprStr(v);
  if (Array.isArray(v)) return '[' + v.map(repr).join(', ') + ']';
  if (isDict(v)) return '{' + [...v].map(([k, x]) => `${reprStr(k)}: ${repr(x)}`).join(', ') + '}';
  return String(v);
}

const reprTuple = (items) => '(' + items.map(repr).join(', ') + (items.length === 1 ? ',)' : ')');

// ---- JSON, as Python's json.loads(str) parses it (C scanner, Python 3.13 messages) ----

class JSONDecodeError extends Error {}

function parseJson(s) {
  const cpPos = (i) => Array.from(s.slice(0, i)).length;
  const fail = (msg, i) => {
    const pos = cpPos(i);
    const before = s.slice(0, i);
    const nl = before.lastIndexOf('\n');
    const line = before.split('\n').length;
    const col = nl < 0 ? pos + 1 : pos - cpPos(nl);
    throw new JSONDecodeError(`${msg}: line ${line} column ${col} (char ${pos})`);
  };
  class Stop {
    constructor(i) {
      this.i = i;
    }
  }
  const ws = (i) => {
    while (i < s.length && ' \t\n\r'.includes(s[i])) i++;
    return i;
  };
  const isDigit = (c) => c >= '0' && c <= '9';
  const isHex = (c) => /^[0-9a-fA-F]$/.test(c || '');

  function str(i) {
    // i is just after the opening quote
    const begin = i - 1;
    let out = '';
    for (;;) {
      if (i >= s.length) fail('Unterminated string starting at', begin);
      const c = s[i];
      if (c === '"') return [out, i + 1];
      if (c === '\\') {
        if (i + 1 >= s.length) fail('Unterminated string starting at', begin);
        const e = s[i + 1];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (e in simple) {
          out += simple[e];
          i += 2;
          continue;
        }
        if (e !== 'u') fail('Invalid \\escape', i);
        const h = s.slice(i + 2, i + 6);
        if (h.length < 4 || ![...h].every(isHex)) fail('Invalid \\uXXXX escape', i + 1);
        out += String.fromCharCode(parseInt(h, 16));
        i += 6;
        continue;
      }
      if (c.charCodeAt(0) < 0x20) fail('Invalid control character at', i);
      out += c;
      i++;
    }
  }

  function value(i) {
    if (i >= s.length) throw new Stop(i);
    const c = s[i];
    if (c === '"') return str(i + 1);
    if (c === '{') return object(i + 1);
    if (c === '[') return array(i + 1);
    for (const [word, v] of [['null', null], ['true', true], ['false', false], ['NaN', NAN], ['Infinity', new PyFloat(Infinity)], ['-Infinity', new PyFloat(-Infinity)]]) {
      if (s.startsWith(word, i)) return [v, i + word.length];
    }
    let j = i;
    if (s[j] === '-') j++;
    if (s[j] >= '1' && s[j] <= '9') while (isDigit(s[j])) j++;
    else if (s[j] === '0') j++;
    else throw new Stop(i);
    let float = false;
    if (s[j] === '.' && isDigit(s[j + 1])) {
      float = true;
      j += 2;
      while (isDigit(s[j])) j++;
    }
    if (s[j] === 'e' || s[j] === 'E') {
      let k = j + 1;
      if (s[k] === '+' || s[k] === '-') k++;
      if (isDigit(s[k])) {
        while (isDigit(s[k])) k++;
        float = true;
        j = k;
      }
    }
    const text = s.slice(i, j);
    if (float) return [new PyFloat(Number(text)), j];
    const digits = text.replace('-', '').length;
    if (digits > 4300) {
      throw new JSONDecodeError(`Exceeds the limit (4300 digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`);
    }
    const big = BigInt(text);
    const n = big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
    return [Object.is(n, -0) ? 0 : n, j];
  }

  function sub(i) {
    try {
      return value(i);
    } catch (e) {
      if (e instanceof Stop) fail('Expecting value', e.i);
      throw e;
    }
  }

  function object(i) {
    const m = new Map();
    i = ws(i);
    if (s[i] === '}') return [m, i + 1];
    if (s[i] !== '"') fail('Expecting property name enclosed in double quotes', i);
    for (;;) {
      let key;
      [key, i] = str(i + 1);
      i = ws(i);
      if (s[i] !== ':') fail("Expecting ':' delimiter", i);
      let v;
      [v, i] = sub(ws(i + 1));
      m.set(key, v);
      i = ws(i);
      if (s[i] === '}') return [m, i + 1];
      if (s[i] !== ',') fail("Expecting ',' delimiter", i);
      const comma = i;
      i = ws(i + 1);
      if (s[i] === '}') fail('Illegal trailing comma before end of object', comma);
      if (s[i] !== '"') fail('Expecting property name enclosed in double quotes', i);
    }
  }

  function array(i) {
    const a = [];
    i = ws(i);
    if (s[i] === ']') return [a, i + 1];
    for (;;) {
      let v;
      [v, i] = sub(i);
      a.push(v);
      i = ws(i);
      if (s[i] === ']') return [a, i + 1];
      if (s[i] !== ',') fail("Expecting ',' delimiter", i);
      const comma = i;
      i = ws(i + 1);
      if (s[i] === ']') fail('Illegal trailing comma before end of array', comma);
    }
  }

  if (s.startsWith('\ufeff')) fail('Unexpected UTF-8 BOM (decode using utf-8-sig)', 0);
  const [v, end] = sub(ws(0));
  const after = ws(end);
  if (after !== s.length) fail('Extra data', after);
  return v;
}

module.exports = {
  WS, PyFloat, JSONDecodeError, strip, splitlines, decodeText, digitsToInt, isInt, isDict, toPy, eq, truthy,
  hashKey, cmpStr, repr, reprTuple, parseJson,
};
