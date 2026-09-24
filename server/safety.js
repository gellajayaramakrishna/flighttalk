'use strict';

const WORDLIST = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'cunt',
  'slut', 'whore', 'nigger', 'nigga', 'faggot', 'retard', 'rape', 'rapist',
  'kill yourself', 'kys', 'suicide', 'porn', 'nude', 'nudes', 'sex',
  'motherfucker', 'cock', 'boobs', 'anal', 'blowjob', 'handjob'
];

const patterns = WORDLIST.map((word) => {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
});

function filterText(input) {
  let filtered = false;
  let text = String(input || '');
  for (const pattern of patterns) {
    const next = text.replace(pattern, (match) => '*'.repeat(match.length));
    if (next !== text) filtered = true;
    text = next;
  }
  return { text, filtered };
}

class RateLimiter {
  constructor(windowMs, max) {
    this.windowMs = windowMs;
    this.max = max;
    this.buckets = new Map();
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
}

module.exports = { filterText, RateLimiter };
