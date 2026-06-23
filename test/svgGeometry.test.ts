import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bakePathData, shapeToPathData } from '../src/svgGeometry';
import { parseTransformList, multiply, apply, Matrix } from '../src/matrix';
import { getter, arcCenter, sampleArc, hausdorff } from './_helpers';

describe('svgGeometry — bake matrix into path', () => {
  test('translate', () => {
    assert.equal(bakePathData('M0 0 L10 0', parseTransformList('translate(5 5)'), 3), 'M 5 5 L 15 5');
  });
  test('scale', () => {
    assert.equal(bakePathData('M1 1 L2 2', parseTransformList('scale(10)'), 3), 'M 10 10 L 20 20');
  });
  test('H/V preserved under axis-aligned matrix', () => {
    assert.equal(bakePathData('M0 0 H10 V10', parseTransformList('scale(2)'), 3), 'M 0 0 H 20 V 20');
  });
  test('H/V become L when rotated', () => {
    assert.equal(bakePathData('M0 0 H10', parseTransformList('rotate(90)'), 3), 'M 0 0 L 0 10');
  });
  test('S baked as absolute C using the reflected control', () => {
    const out = bakePathData('M0 0 C0 10 10 10 10 0 S20 -10 20 0', parseTransformList('translate(1 1)'), 3);
    assert.ok(out.startsWith('M 1 1 C 1 11 11 11 11 1 C 11 -9 21 -9 21 1'), out);
  });
});

describe('svgGeometry — basic shapes to path', () => {
  test('rect', () => {
    assert.equal(shapeToPathData('rect', getter({ x: '0', y: '0', width: '10', height: '20' }), 3), 'M0 0H10V20H0Z');
  });
  test('rect with rounded corners uses arcs', () => {
    const d = shapeToPathData('rect', getter({ x: '0', y: '0', width: '10', height: '10', rx: '2' }), 3);
    assert.ok(d && d.includes('A2 2'), String(d));
  });
  test('line', () => {
    assert.equal(shapeToPathData('line', getter({ x1: '1', y1: '2', x2: '3', y2: '4' }), 3), 'M1 2L3 4');
  });
  test('polygon closes, polyline does not', () => {
    assert.equal(shapeToPathData('polygon', getter({ points: '0,0 10,0 10,10' }), 3), 'M0 0L10 0L10 10Z');
    assert.equal(shapeToPathData('polyline', getter({ points: '0,0 10,0' }), 3), 'M0 0L10 0');
  });
  // `points` uses the same number grammar as path data: the sign separates
  // coordinates ("5-5") and decimals pack (".5.5"). The naive split used to drop
  // these as NaN. Coordinates verified against the browser's polygon.points.
  test('points with packed / sign-separated numbers (BNF conformance)', () => {
    // "5-5-5-4" -> (5,-5),(-5,-4)  ;  "10.5.5" -> (10.5, 0.5)
    assert.equal(
      shapeToPathData('polygon', getter({ points: '5-5-5-4 10.5.5' }), 3),
      'M5 -5L-5 -4L10.5 0.5Z',
    );
    // mixed comma + sign-as-separator, like Illustrator/Figma exports
    assert.equal(
      shapeToPathData('polyline', getter({ points: '0,0 5-5-5-4' }), 3),
      'M0 0L5 -5L-5 -4',
    );
  });
  test('circle and ellipse close', () => {
    assert.ok(shapeToPathData('circle', getter({ cx: '5', cy: '5', r: '4' }), 3)?.endsWith('Z'));
    assert.ok(shapeToPathData('ellipse', getter({ cx: '5', cy: '5', rx: '4', ry: '2' }), 3)?.endsWith('Z'));
  });
  test('degenerate shapes return null', () => {
    assert.equal(shapeToPathData('rect', getter({ width: '0', height: '5' }), 3), null);
    assert.equal(shapeToPathData('circle', getter({ r: '0' }), 3), null);
    assert.equal(shapeToPathData('polygon', getter({ points: '0,0' }), 3), null);
  });
});

describe('svgGeometry — arc transform is geometry-exact (Hausdorff)', () => {
  const mats: [string, Matrix][] = [
    ['rotate', parseTransformList('rotate(30)')],
    ['scaleNU', parseTransformList('scale(2 0.5)')],
    ['skewX', parseTransformList('skewX(20)')],
    ['combo', multiply(parseTransformList('rotate(25)'), parseTransformList('scale(1.5 0.7) skewX(10)'))],
    ['flip', parseTransformList('scale(-1 1)')],
  ];
  const arcs = [
    { sx: 10, sy: 50, rx: 30, ry: 20, rot: 0, large: 0, sweep: 1, ex: 70, ey: 50, name: 'small' },
    { sx: 10, sy: 50, rx: 30, ry: 20, rot: 0, large: 1, sweep: 0, ex: 70, ey: 50, name: 'large' },
    { sx: 20, sy: 20, rx: 30, ry: 15, rot: 40, large: 0, sweep: 1, ex: 80, ey: 60, name: 'rotated-ellipse' },
  ];
  const ARC_RE = /A\s*([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([01])\s+([01])\s+([\d.eE+-]+)\s+([\d.eE+-]+)/;

  for (const [mn, m] of mats) {
    for (const a of arcs) {
      test(`${mn} / ${a.name}`, () => {
        const c0 = arcCenter(a.sx, a.sy, a.ex, a.ey, a.rx, a.ry, a.rot, a.large, a.sweep);
        const orig = sampleArc(c0, 200).map((p) => apply(m, p.x, p.y));
        const baked = bakePathData(`M${a.sx} ${a.sy} A${a.rx} ${a.ry} ${a.rot} ${a.large} ${a.sweep} ${a.ex} ${a.ey}`, m, 9);
        const mm = ARC_RE.exec(baked);
        assert.ok(mm, `arc command present in: ${baked}`);
        const ns = apply(m, a.sx, a.sy), ne = apply(m, a.ex, a.ey);
        const c1 = arcCenter(ns.x, ns.y, +mm![6], +mm![7], +mm![1], +mm![2], +mm![3], +mm![4], +mm![5]);
        const np = sampleArc(c1, 200);
        const scale = Math.max(1, Math.hypot(ns.x - ne.x, ns.y - ne.y));
        const d = Math.max(hausdorff(orig, np), hausdorff(np, orig));
        assert.ok(d < 1e-2 * scale, `hausdorff ${d.toExponential(2)} for ${baked}`);
      });
    }
  }
});
