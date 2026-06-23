import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, tokenizeNumbers, parseNumberListStrict } from '../src/pathParser';

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

  test('multiline d (newlines, tabs, CRLF) parses like single-line', () => {
    const lf = parsePath('M 39 10\n  a 24 24 0 1 1 -14 0\n  v 8\n  a 16 16 0 1 0 12 0 z').segments;
    assert.deepEqual(lf.map((s) => s.upper), ['M', 'A', 'V', 'A', 'Z']);
    const crlf = parsePath('M0 0\r\n  L5 5\r\n  L10 0').segments;
    assert.deepEqual(crlf.map((s) => s.upper), ['M', 'L', 'L']);
    assert.deepEqual([crlf[2].absEnd.x, crlf[2].absEnd.y], [10, 0]);
  });

  test('a single segment whose args span lines resolves correctly', () => {
    const segs = parsePath('M 0 0 C 10 10\n\t\t20 20\n\t\t30 30').segments;
    assert.deepEqual(segs.map((s) => s.upper), ['M', 'C']);
    assert.deepEqual([segs[1].absEnd.x, segs[1].absEnd.y], [30, 30]);
    // a source range still maps to a clean token across the line break
    const d = 'M 0 0 C 10 10\n\t\t20 20\n\t\t30 30';
    const c2 = segs[1].points[1]; // second control point on line 2
    assert.equal(d.slice(c2.start, c2.end), '20 20');
  });

  test('Unicode minus (U+2212) is parsed as a negative number', () => {
    const a = parsePath('M0 0 l 8,−17 −4 0').segments[1];
    assert.equal(a.absEnd.x, 8);
    assert.equal(a.absEnd.y, -17);
  });

  // Numbers may be packed with no separating whitespace — the sign acts as the
  // separator (5-5-5-4), decimals chain (.5.5), and a missing command letter
  // means "repeat the previous command" (implicit segment). Verified against the
  // browser's native SVG parser: every case below traces the identical curve.
  describe('packed numbers & implicit segments (no separators)', () => {
    test('sign-as-separator splits a packed run into segments', () => {
      const segs = parsePath('M5-5-5-4').segments;
      assert.deepEqual(segs.map((s) => s.upper), ['M', 'L']); // implicit lineto, no "L" letter
      assert.equal(segs[1].explicit, false);
      assert.deepEqual(segs[0].args.map((a) => a.raw), ['5', '-5']);
      assert.deepEqual(segs[1].args.map((a) => a.raw), ['-5', '-4']);
      // implicit lineto after an ABSOLUTE M is itself absolute
      assert.deepEqual([segs[0].absEnd.x, segs[0].absEnd.y], [5, -5]);
      assert.deepEqual([segs[1].absEnd.x, segs[1].absEnd.y], [-5, -4]);
    });

    test('packed decimals: .5.5.5.5 is four 0.5 values, implicit absolute lineto', () => {
      const segs = parsePath('M.5.5.5.5').segments;
      assert.deepEqual(segs.map((s) => s.upper), ['M', 'L']);
      assert.deepEqual([segs[0].absEnd.x, segs[0].absEnd.y], [0.5, 0.5]);
      assert.deepEqual([segs[1].absEnd.x, segs[1].absEnd.y], [0.5, 0.5]); // absolute, not 1,1
    });

    test('single-arg command repeats implicitly (h-4-3-2 -> three H)', () => {
      const segs = parsePath('M0 0h-4-3-2').segments;
      assert.deepEqual(segs.map((s) => s.upper), ['M', 'H', 'H', 'H']);
      assert.deepEqual(segs.slice(1).map((s) => s.absEnd.x), [-4, -7, -9]); // relative, cumulative
    });

    test('packed cubic: control/endpoint source ranges stay clean tokens', () => {
      const d = 'M0 0c0 10 10 10 10 0-5-10-15-10-20 0';
      const segs = parsePath(d).segments;
      assert.deepEqual(segs.map((s) => s.upper), ['M', 'C', 'C']);
      const c = segs[2]; // the implicit cubic, fully packed with sign separators
      const [c1, c2, ep] = c.points;
      assert.equal(d.slice(c1.start, c1.end), '-5-10');
      assert.equal(d.slice(c2.start, c2.end), '-15-10');
      assert.equal(d.slice(ep.start, ep.end), '-20 0');
    });

    test('packed arc flags glued to coordinates (a5 5 0 0110-10)', () => {
      const a = parsePath('M0 0a5 5 0 0110-10').segments[1];
      assert.equal(a.upper, 'A');
      assert.deepEqual([a.args[3].raw, a.args[4].raw], ['0', '1']); // large-arc=0, sweep=1
      assert.deepEqual([a.args[5].value, a.args[6].value], [10, -10]);
    });
  });

  test('Z returns to subpath start', () => {
    const segs = parsePath('M5 5 L20 5 L20 20 Z').segments;
    const z = segs[segs.length - 1];
    assert.equal(z.upper, 'Z');
    assert.deepEqual([z.absEnd.x, z.absEnd.y], [5, 5]);
  });
});

// The shared number tokenizer used for `points` and transform arguments. It must
// honour the SVG BNF the same way readNumber does for path data.
describe('tokenizeNumbers / parseNumberListStrict', () => {
  test('sign-as-separator, packed decimals, exponents, Unicode minus', () => {
    assert.deepEqual(tokenizeNumbers('5-5-5-4'), [5, -5, -5, -4]);
    assert.deepEqual(tokenizeNumbers('.5.5.5.5'), [0.5, 0.5, 0.5, 0.5]);
    assert.deepEqual(tokenizeNumbers('0,0 5-5'), [0, 0, 5, -5]);
    assert.deepEqual(tokenizeNumbers('1.5e1 2.5e-1'), [15, 0.25]);
    assert.deepEqual(tokenizeNumbers('8,−17 −4'), [8, -17, -4]); // U+2212
  });

  test('lenient tokenizer keeps the valid prefix; strict rejects on garbage', () => {
    assert.deepEqual(tokenizeNumbers('2,x 3'), [2]);      // stops at the stray token
    assert.equal(parseNumberListStrict('2,x'), null);     // any garbage -> null
    assert.deepEqual(parseNumberListStrict('5-5 6'), [5, -5, 6]);
    assert.deepEqual(parseNumberListStrict('  '), []);    // empty/whitespace -> []
  });
});
