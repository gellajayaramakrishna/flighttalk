'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/js/pass-parse');

const ONE_LEG = 'M1GELLA/JAYARAMAKRISHNEABC123 BOMDELAI 0865 315Y012A0045 100';

test('BCBP: parses a single-leg boarding pass', () => {
  const r = P.parseBCBP(ONE_LEG, { refDate: new Date('2026-11-11T10:00:00Z') });
  assert.equal(r.source, 'barcode');
  assert.equal(r.flight, 'AI865');
  assert.equal(r.seat, '12A');
  assert.equal(r.from, 'BOM');
  assert.equal(r.to, 'DEL');
  assert.equal(r.pnr, 'ABC123');
  assert.equal(r.date, '2026-11-11');
  assert.deepEqual(r.name, { surname: 'GELLA', given: 'JAYARAMAKRISHN', full: 'GELLA/JAYARAMAKRISHN' });
});

test('BCBP: strips the title and handles alphanumeric carriers like 6E', () => {
  const r = P.parseBCBP(`M1${'SHARMA/PRIYA MS'.padEnd(20)}EXYZ987 BLRHYD6E 2134 120Y023F0101 100`);
  assert.equal(r.flight, '6E2134');
  assert.equal(r.seat, '23F');
  assert.equal(r.name.given, 'PRIYA');
});

test('BCBP: multi-leg pass picks the leg for this cabin', () => {
  const leg1 = `M2${'DOE/JOHN MR'.padEnd(20)}EABC123 DELBOMAI 0101 100Y010C0001 100`;
  const leg2 = 'ABC123 BOMDXBAI 0909 100Y031K0002 100';
  const r = P.parseBCBP(leg1 + leg2);
  assert.equal(r.legs.length, 2);
  assert.equal(r.flight, 'AI101');
  const picked = P.pickLeg(r, 'AI909');
  assert.equal(picked.flight, 'AI909');
  assert.equal(picked.seat, '31K');
  assert.equal(picked.to, 'DXB');
});

test('BCBP: rejects garbage and non-boarding-pass QR codes', () => {
  assert.equal(P.parseBCBP('https://example.com'), null);
  assert.equal(P.parseBCBP(''), null);
  assert.equal(P.parseBCBP('M1' + 'X'.repeat(30)), null);
});

test('seat and flight normalisation', () => {
  assert.equal(P.normalizeSeat('012A'), '12A');
  assert.equal(P.normalizeSeat('12 a'), '12A');
  assert.equal(P.normalizeSeat('12I'), ''); // row letter I is never used
  assert.equal(P.normalizeSeat('0A'), '');
  assert.equal(P.normalizeFlight('AI', '0865'), 'AI865');
  assert.equal(P.normalizeFlight('6E', '12345'), '');
});

test('OCR: slash-style name, labelled flight and seat', () => {
  const r = P.parseOcrText('BOARDING PASS\nNAME: GELLA/JAYARAMA KRISHNA MR\nFLIGHT AI 865   DATE 11NOV\nFROM BOM TO DEL\nGATE 12B  SEAT 14C');
  assert.equal(r.name.surname, 'GELLA');
  assert.equal(r.name.given, 'JAYARAMA KRISHNA');
  assert.equal(r.flight, 'AI865');
  assert.equal(r.seat, '14C'); // not the gate "12B"
  assert.equal(r.from, 'BOM');
});

test('OCR: label row + value row (columns) and glued tokens', () => {
  const r = P.parseOcrText('Passenger Name\nMR TANVI PATEL\nFLIGHT FROM TO GATE SEAT\nQR 2392VTZ DOH 40 33D');
  assert.equal(r.flight, 'QR2392');
  assert.equal(r.seat, '33D');
  assert.equal(r.name.surname, 'PATEL');
});

test('OCR: survives typical Tesseract confusions', () => {
  const r = P.parseOcrText('GELLA | JAYARAMA MR\nFLT Al 0865\nSEAT 0O9A');
  assert.equal(r.flight, 'AI865');
  assert.equal(r.seat, '9A');
  assert.equal(r.name.surname, 'GELLA');
});

test('OCR: the flight carrier "6E" is not mistaken for a seat', () => {
  const r = P.parseOcrText('MS KAVYA GUPTA\n6E 1006 BLR GOI');
  assert.equal(r.flight, '6E1006');
  assert.notEqual(r.seat, '6E');
});

test('v1 regex could never read the name (regression baseline)', () => {
  assert.equal(P.legacyOcrParse('NAME: GELLA/JAYARAMA MR').name, null);
});

test('identity key matches between barcode (truncated) and OCR (full) reads', () => {
  const fromBarcode = P.parseBCBP(ONE_LEG).name;
  const fromOcr = P.parseOcrText('GELLA/JAYARAMA KRISHNA MR').name;
  assert.equal(P.identityKey(fromBarcode), P.identityKey(fromOcr));
});

test('display-name suggestion is the first 3 letters of the given name', () => {
  assert.equal(P.suggestDisplayName({ surname: 'GELLA', given: 'JAYARAMA KRISHNA' }), 'Jay');
  assert.equal(P.suggestDisplayName({ surname: 'LI', given: 'AN' }), 'An');
});
