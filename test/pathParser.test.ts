import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath } from '../src/pathParser';

describe('pathParser', () => {
  test('implicit lineto after moveto', () => {
    const segs = parsePath('M0 0 1 1 2 2').segments;
    assert.deepEqual(segs.map((s) => s.upper), ['M', 'L', 'L']);
    assert.equal(segs[0].explicit, true);
    assert.equal(segs[1].explicit, false);
  });

  test('packed arc flags without separators', () => {
    const a = parsePath('M0 0a5 5 0 0110 10').segments[1];
    assert.equal(a.upper, 'A');
    assert.deepEqual([a.args[3].raw, a.args[4].raw], ['0', '1']);
    assert.deepEqual([a.args[5].value, a.args[6].value], [10, 10]);
  });

  test('S reflected control is computed and source-less', () => {
    const s = parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0').segments[2];
    const refl = s.points[0];
    assert.equal(refl.role, 'control');
    assert.equal(refl.hasSource, false);
    // reflection of (10,10) about current point (10,0) -> (10,-10)
    assert.equal(refl.x, 10);
    assert.equal(refl.y, -10);
  });

  test('endpoint source ranges map back to the text', () => {
    const d = 'M0 0 L10 10';
    const pt = parsePath(d).segments[1].points[0];
    assert.equal(d.slice(pt.start, pt.end), '10 10');
  });

  test('relative commands resolve to absolute positions', () => {
    const segs = parsePath('M10 10 l5 5').segments;
    assert.deepEqual([segs[1].absEnd.x, segs[1].absEnd.y], [15, 15]);
  });

  test('H/V endpoints', () => {
    const segs = parsePath('M0 0 H40 V30').segments;
    assert.deepEqual([segs[1].absEnd.x, segs[1].absEnd.y], [40, 0]);
    assert.deepEqual([segs[2].absEnd.x, segs[2].absEnd.y], [40, 30]);
  });

  test('Z returns to subpath start', () => {
    const segs = parsePath('M5 5 L20 5 L20 20 Z').segments;
    const z = segs[segs.length - 1];
    assert.equal(z.upper, 'Z');
    assert.deepEqual([z.absEnd.x, z.absEnd.y], [5, 5]);
  });
});
