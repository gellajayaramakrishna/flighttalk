'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filterText, shieldPII, RateLimiter, RepeatDetector } = require('../server/safety');

test('profanity filter masks words and common obfuscation', () => {
  for (const s of ['you are a bitch', 'sh1t happens', 'f.u.c.k off', 'B!TCH']) {
    const r = filterText(s);
    assert.equal(r.filtered, true, s);
    assert.match(r.text, /\*{3,}/);
  }
});

test('profanity filter has no false positives on normal words', () => {
  for (const s of ['Scunthorpe United', 'business class please', 'assistant', 'Dickens novel', 'cocktail', 'sextant']) {
    assert.equal(filterText(s).filtered, false, s);
  }
});

test('PII shield hides phone numbers, emails, links and handles', () => {
  const r = shieldPII('call 98765 43210 or +91 9876543210, mail a.b@gmail.com, see www.site.com, insta @jay_k99');
  assert.ok(!/98765|9876543210|gmail|site\.com|jay_k99/.test(r.text), r.text);
  assert.deepEqual(new Set(r.kinds), new Set(['phone', 'email', 'link', 'handle']));
});

test('PII shield leaves flight talk alone', () => {
  const s = 'Flight AI 865 lands at 14:35, I am in row 12, gate 7B, 2 hours left';
  assert.equal(shieldPII(s).text, s);
});

test('rate limiter allows a burst then blocks', () => {
  const rl = new RateLimiter(10_000, 3);
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow('u')), [true, true, true, false]);
  assert.equal(rl.allow('other'), true);
});

test('repeat detector catches copy-paste spam', () => {
  const r = new RepeatDetector(3, 60_000);
  const out = [1, 2, 3, 4].map(() => r.isSpam('u', 'JOIN MY ROOM!!'));
  assert.deepEqual(out, [false, false, false, true]);
  assert.equal(r.isSpam('u', 'something else'), false);
});
