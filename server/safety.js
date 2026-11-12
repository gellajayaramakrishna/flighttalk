'use strict';

/*
 * Local, offline content-safety helpers. No cloud moderation API is available
 * on an aircraft, so everything here is deterministic and runs in-process.
 */

const WORDLIST = [
  'fuck', 'fucker', 'fucking', 'fck', 'fuk', 'fking', 'sht', 'btch', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'cunt',
  'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'rapist',
  'kill yourself', 'kys', 'porn', 'nude', 'nudes', 'motherfucker', 'cock', 'boobs',
  'blowjob', 'handjob', 'madarchod', 'bhenchod', 'chutiya', 'gaandu', 'randi'
];

// Undo common obfuscation before matching: "f*ck", "sh1t", "b!tch", "f u c k".
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '!': 'i', '+': 't' };

function normalizeForMatch(s) {
  return String(s).toLowerCase().replace(/[013457@$!+]/g, (c) => LEET[c]);
}

const patterns = WORDLIST.map((word) => {
  // Allow up to one junk character (*, ., -, _, space) between letters: f*u*c*k, f.u.c.k
  const body = word.split('').map((ch) => (ch === ' ' ? '\\s+' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('[\\*\\.\\-_ ]?');
  return new RegExp(`(?<![a-z])${body}(?![a-z])`, 'gi');
});

/** Mask profanity. Works on a normalised copy and masks the same character range in the original. */
function filterText(input) {
  const original = String(input || '');
  const norm = normalizeForMatch(original);
  const mask = new Array(original.length).fill(false);
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(norm))) {
      for (let i = m.index; i < m.index + m[0].length; i += 1) mask[i] = true;
    }
  }
  if (!mask.includes(true)) return { text: original, filtered: false };
  const text = original.split('').map((ch, i) => (mask[i] && ch !== ' ' ? '*' : ch)).join('');
  return { text, filtered: true };
}

function containsProfanity(input) {
  return filterText(input).filtered;
}

/*
 * Personal-information shield. In public spaces (cabin chat, rooms) we mask
 * contact details and links before anyone else sees them. Strangers on a flight
 * asking for phone numbers is a classic grooming / scam pattern, and links are
 * useless offline anyway (they can only point to phishing once you land).
 */
const PII_RULES = [
  { kind: 'email', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, label: '[email hidden]' },
  { kind: 'link', re: /\b(?:https?:\/\/|www\.)[^\s]+/gi, label: '[link hidden]' },
  { kind: 'link', re: /\b[a-z0-9-]+\.(?:com|in|net|org|io|me|co|app|xyz|link|ly)\b(?:\/[^\s]*)?/gi, label: '[link hidden]' },
  { kind: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, label: '[number hidden]' },
  { kind: 'phone', re: /(?:\+?\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,5}\b/g, label: '[phone hidden]', minDigits: 8 },
  { kind: 'handle', re: /(?:^|\s)@[a-z0-9_.]{3,30}\b/gi, label: ' [handle hidden]' }
];

function shieldPII(input) {
  let text = String(input || '');
  const found = new Set();
  for (const rule of PII_RULES) {
    text = text.replace(rule.re, (match) => {
      if (rule.minDigits && match.replace(/\D/g, '').length < rule.minDigits) return match;
      found.add(rule.kind);
      return rule.label;
    });
  }
  return { text, kinds: [...found] };
}

function detectPII(input) {
  return shieldPII(input).kinds;
}

/** Fixed-window rate limiter with periodic cleanup so memory stays bounded on a long flight. */
class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
    const t = setInterval(() => this.sweep(), Math.max(windowMs, 30_000));
    if (t.unref) t.unref();
  }

  allow(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start > this.windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.max;
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.start > this.windowMs) this.buckets.delete(k);
  }
}

/** Detects one passenger sending the same text over and over (copy-paste spam). */
class RepeatDetector {
  constructor(limit = 3, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.last = new Map();
  }

  isSpam(userId, text) {
    const key = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
    const now = Date.now();
    const entry = this.last.get(userId);
    if (entry && entry.key === key && now - entry.at < this.windowMs) {
      entry.count += 1;
      entry.at = now;
      return entry.count > this.limit;
    }
    this.last.set(userId, { key, count: 1, at: now });
    return false;
  }
}

module.exports = { filterText, containsProfanity, shieldPII, detectPII, RateLimiter, RepeatDetector };
