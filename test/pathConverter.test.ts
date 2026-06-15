import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { convertD, fullAbsoluteD, segmentOverlayD, formatNumber } from '../src/pathConverter';
import { parsePath } from '../src/pathParser';

describe('pathConverter', () => {
  test('relative -> absolute', () => {
    assert.equal(convertD('m 10 10 l 5 0 l 0 5 z', 'abs', 3), 'M 10 10 L 15 10 L 15 15 Z');
  });

  test('absolute -> relative (first moveto stays absolute)', () => {
    assert.equal(convertD('M 10 10 L 15 10 L 15 15 Z', 'rel', 3), 'M 10 10 l 5 0 l 0 5 z');
  });

  test('implicit lineto -> absolute', () => {
    assert.equal(convertD('M0 0 1 1 2 2', 'abs', 3), 'M 0 0 L 1 1 L 2 2');
  });

  test('H/V absolute -> relative', () => {
    assert.equal(convertD('M100 130 H140 V160 H100 Z', 'rel', 3), 'M 100 130 h 40 v 30 h -40 z');
  });

  test('arc keeps kind and flags, converts endpoint', () => {
    assert.equal(convertD('M20 160 a 30 30 0 0 1 60 0', 'abs', 3), 'M 20 160 A 30 30 0 0 1 80 160');
  });

  test('abs<->rel<->abs round trip is stable', () => {
    const d = 'M30,30 q40,-20 80,0 t80,0';
    const there = convertD(d, 'abs', 6);
    assert.equal(convertD(convertD(there, 'rel', 6), 'abs', 6), there);
  });

  test('fullAbsoluteD expands S to C exactly', () => {
    assert.equal(
      fullAbsoluteD(parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0').segments),
      'M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0',
    );
  });

  test('segmentOverlayD prefixes a moveto to the segment start', () => {
    assert.equal(segmentOverlayD(parsePath('M0 0 L10 10').segments[1]), 'M 0 0 L 10 10');
  });

  test('formatNumber trims float noise, -0 and trailing zeros', () => {
    assert.equal(formatNumber(0.30000000000000004, 6), '0.3');
    assert.equal(formatNumber(-0, 6), '0');
    assert.equal(formatNumber(10, 3), '10');
    assert.equal(formatNumber(1.5, 6), '1.5');
  });
});
