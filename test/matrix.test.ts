import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseTransformList, matrixToString, multiply, apply, det, isIdentity, IDENTITY } from '../src/matrix';
import { assertClose } from './_helpers';

describe('matrix', () => {
  test('parse translate / scale / rotate / skew', () => {
    assert.equal(matrixToString(parseTransformList('translate(10 20)'), 3), 'matrix(1 0 0 1 10 20)');
    assert.equal(matrixToString(parseTransformList('translate(10)'), 3), 'matrix(1 0 0 1 10 0)');
    assert.equal(matrixToString(parseTransformList('scale(2 3)'), 3), 'matrix(2 0 0 3 0 0)');
    assert.equal(matrixToString(parseTransformList('scale(3)'), 3), 'matrix(3 0 0 3 0 0)');
    assert.equal(matrixToString(parseTransformList('rotate(90)'), 3), 'matrix(0 1 -1 0 0 0)');
    assert.equal(matrixToString(parseTransformList('skewX(45)'), 3), 'matrix(1 0 1 1 0 0)');
    assert.equal(matrixToString(parseTransformList('skewY(45)'), 3), 'matrix(1 1 0 1 0 0)');
  });

  test('commas and extra whitespace tolerated', () => {
    assert.equal(matrixToString(parseTransformList('translate( 10 , 20 )'), 3), 'matrix(1 0 0 1 10 20)');
  });

  test('compose order is A·B (leftmost outermost)', () => {
    assert.equal(matrixToString(parseTransformList('translate(10 10) scale(2)'), 3), 'matrix(2 0 0 2 10 10)');
  });

  test('rotate about a center keeps the center fixed', () => {
    const m = parseTransformList('rotate(90 10 10)');
    const p = apply(m, 10, 10);
    assertClose(p.x, 10);
    assertClose(p.y, 10);
  });

  test('apply matches manual composition', () => {
    const m = multiply(parseTransformList('translate(5 0)'), parseTransformList('rotate(90)'));
    const p = apply(m, 1, 0);
    assertClose(p.x, 5);
    assertClose(p.y, 1);
  });

  test('malformed argument counts are skipped (no NaN poisoning)', () => {
    assert.equal(matrixToString(parseTransformList('matrix(1 2 3)'), 3), 'matrix(1 0 0 1 0 0)');
    assert.equal(matrixToString(parseTransformList('translate(5 5) scale()'), 3), 'matrix(1 0 0 1 5 5)');
    assert.equal(matrixToString(parseTransformList('rotate(10 20)'), 3), 'matrix(1 0 0 1 0 0)');
    assert.equal(matrixToString(parseTransformList('matrix(a b c d e f)'), 3), 'matrix(1 0 0 1 0 0)');
  });

  // Per the SVG BNF, the sign doubles as a separator and numbers may be packed
  // with no whitespace — browsers accept "translate(5-5)". Verified against the
  // browser's transform.baseVal.consolidate().
  test('packed / sign-separated transform arguments (BNF conformance)', () => {
    assert.equal(matrixToString(parseTransformList('translate(5-5)'), 3), 'matrix(1 0 0 1 5 -5)');
    assert.equal(matrixToString(parseTransformList('matrix(1 0 0 1-5-5)'), 3), 'matrix(1 0 0 1 -5 -5)');
    assert.equal(matrixToString(parseTransformList('scale(.5e1.5e1)'), 3), 'matrix(5 0 0 5 0 0)');
    // a stray non-number token still invalidates the function (strict parse)
    assert.equal(matrixToString(parseTransformList('scale(2,x)'), 3), 'matrix(1 0 0 1 0 0)');
  });

  test('det and isIdentity', () => {
    assert.equal(det(parseTransformList('scale(2 3)')), 6);
    assert.equal(det(parseTransformList('scale(-1 1)')), -1);
    assert.ok(isIdentity(IDENTITY));
    assert.ok(isIdentity(parseTransformList('translate(0 0)')));
    assert.ok(!isIdentity(parseTransformList('scale(2)')));
  });
});
