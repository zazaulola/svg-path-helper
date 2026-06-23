// 2D affine matrices and SVG `transform` list parsing/composition.
//
// Matrix maps a point (x,y) -> (a*x + c*y + e, b*x + d*y + f), matching the
// SVG `matrix(a b c d e f)` convention.

import { formatNumber } from './pathConverter';
import { parseNumberListStrict } from './pathParser';

export interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number; }

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Compose m1 then m2 as transforms: result maps p -> m1·(m2·p). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

export function isIdentity(m: Matrix, eps = 1e-9): boolean {
  return Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps
    && Math.abs(m.d - 1) < eps && Math.abs(m.e) < eps && Math.abs(m.f) < eps;
}

/** Determinant of the linear part. */
export function det(m: Matrix): number {
  return m.a * m.d - m.b * m.c;
}

function fnToMatrix(name: string, args: number[]): Matrix {
  switch (name) {
    case 'matrix':
      return { a: args[0], b: args[1], c: args[2], d: args[3], e: args[4], f: args[5] };
    case 'translate':
      return { ...IDENTITY, e: args[0] || 0, f: args.length > 1 ? args[1] : 0 };
    case 'scale': {
      const sx = args[0];
      const sy = args.length > 1 ? args[1] : args[0];
      return { ...IDENTITY, a: sx, d: sy };
    }
    case 'rotate': {
      const r = (args[0] || 0) * Math.PI / 180;
      const cos = Math.cos(r), sin = Math.sin(r);
      const rot: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (args.length >= 3) {
        const cx = args[1], cy = args[2];
        return multiply(multiply({ ...IDENTITY, e: cx, f: cy }, rot), { ...IDENTITY, e: -cx, f: -cy });
      }
      return rot;
    }
    case 'skewX':
      return { ...IDENTITY, c: Math.tan((args[0] || 0) * Math.PI / 180) };
    case 'skewY':
      return { ...IDENTITY, b: Math.tan((args[0] || 0) * Math.PI / 180) };
    default:
      return IDENTITY;
  }
}

const TRANSFORM_FN = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;

// Valid argument counts per function; anything else is skipped (a malformed
// function must not poison the composed matrix with NaN/undefined).
const ARG_COUNTS: Record<string, number[]> = {
  matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1],
};

/** Parse an SVG transform list string into a single composed matrix. */
export function parseTransformList(s: string): Matrix {
  let m = IDENTITY;
  let match: RegExpExecArray | null;
  TRANSFORM_FN.lastIndex = 0;
  while ((match = TRANSFORM_FN.exec(s)) !== null) {
    // Sign-as-separator and packed numbers are valid here too ("translate(5-5)");
    // a stray non-number token invalidates the function (parseNumberListStrict -> null).
    const args = parseNumberListStrict(match[2]);
    if (!args) continue;
    if (!ARG_COUNTS[match[1]].includes(args.length)) continue;
    m = multiply(m, fnToMatrix(match[1], args));
  }
  return m;
}

export function matrixToString(m: Matrix, precision: number): string {
  const f = (n: number) => formatNumber(n, precision);
  return `matrix(${f(m.a)} ${f(m.b)} ${f(m.c)} ${f(m.d)} ${f(m.e)} ${f(m.f)})`;
}
