// Baking an affine matrix into path geometry, and converting SVG basic shapes
// to <path> data.

import { parsePath, tokenizeNumbers } from './pathParser';
import { formatNumber } from './pathConverter';
import { Matrix, apply, det } from './matrix';

/**
 * Closed-form SVD of the 2x2 matrix [[a, b], [c, d]].
 * Returns the singular values (sx >= sy) and the rotation of the left singular
 * vectors (orientation of the major axis). Used to transform elliptical arcs.
 */
function svd2(a: number, b: number, c: number, d: number): { sx: number; sy: number; angle: number } {
  const e = (a + d) / 2;
  const f = (a - d) / 2;
  const g = (c + b) / 2;
  const h = (c - b) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  const sx = q + r;
  const sy = q - r;
  const a1 = Math.atan2(g, f);
  const a2 = Math.atan2(h, e);
  const angle = (a2 + a1) / 2; // rotation of U (left singular vectors / major-axis orientation)
  return { sx: Math.abs(sx), sy: Math.abs(sy), angle };
}

/** Transform one elliptical-arc segment by matrix m; returns the new `A ...`/`L ...` command. */
function bakeArc(
  rx0: number, ry0: number, rotDeg: number, large: number, sweep: number,
  endX: number, endY: number, m: Matrix, f: (n: number) => string,
): string {
  const end = apply(m, endX, endY);
  let rx = Math.abs(rx0), ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) return `L ${f(end.x)} ${f(end.y)}`;

  const rot = rotDeg * Math.PI / 180;
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  // Ellipse generator G = R(rot)·diag(rx,ry) maps the unit circle to the arc's ellipse.
  // Columns of G: [g0,g1]=R·(rx,0), [g2,g3]=R·(0,ry).
  const g0 = rx * cosr, g1 = rx * sinr, g2 = -ry * sinr, g3 = ry * cosr;
  // New generator A = L·G, where L is the linear part of m ([[a,c],[b,d]]).
  const A00 = m.a * g0 + m.c * g1;
  const A10 = m.b * g0 + m.d * g1;
  const A01 = m.a * g2 + m.c * g3;
  const A11 = m.b * g2 + m.d * g3;

  const { sx, sy, angle } = svd2(A00, A01, A10, A11);
  let newSweep = sweep;
  if (det(m) < 0) newSweep = sweep ? 0 : 1; // reflection flips winding
  const phiDeg = angle * 180 / Math.PI;
  return `A ${f(sx)} ${f(sy)} ${f(phiDeg)} ${large} ${newSweep} ${f(end.x)} ${f(end.y)}`;
}

/** Bake matrix m into a path `d` string, producing an equivalent transform-free `d`. */
export function bakePathData(d: string, m: Matrix, precision: number): string {
  const { segments } = parsePath(d);
  const f = (n: number) => formatNumber(n, precision);
  const P = (x: number, y: number) => { const p = apply(m, x, y); return `${f(p.x)} ${f(p.y)}`; };
  // Under an axis-aligned matrix (no rotation/skew) H stays H and V stays V.
  const axisAligned = Math.abs(m.b) < 1e-12 && Math.abs(m.c) < 1e-12;
  const out: string[] = [];

  for (const seg of segments) {
    switch (seg.upper) {
      case 'M': out.push(`M ${P(seg.absEnd.x, seg.absEnd.y)}`); break;
      case 'L': out.push(`L ${P(seg.absEnd.x, seg.absEnd.y)}`); break;
      case 'H':
        if (axisAligned) out.push(`H ${f(apply(m, seg.absEnd.x, seg.absEnd.y).x)}`);
        else out.push(`L ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      case 'V':
        if (axisAligned) out.push(`V ${f(apply(m, seg.absEnd.x, seg.absEnd.y).y)}`);
        else out.push(`L ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      case 'C':
        out.push(`C ${P(seg.controlAbs[0].x, seg.controlAbs[0].y)} ${P(seg.controlAbs[1].x, seg.controlAbs[1].y)} ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      case 'S': {
        const r = seg.points[0]; // reflected control (absolute)
        out.push(`C ${P(r.x, r.y)} ${P(seg.controlAbs[0].x, seg.controlAbs[0].y)} ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      }
      case 'Q':
        out.push(`Q ${P(seg.controlAbs[0].x, seg.controlAbs[0].y)} ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      case 'T': {
        const r = seg.points[0];
        out.push(`Q ${P(r.x, r.y)} ${P(seg.absEnd.x, seg.absEnd.y)}`);
        break;
      }
      case 'A':
        out.push(bakeArc(
          seg.args[0].value, seg.args[1].value, seg.args[2].value,
          seg.args[3].value, seg.args[4].value, seg.absEnd.x, seg.absEnd.y, m, f,
        ));
        break;
      case 'Z': out.push('Z'); break;
    }
  }
  return out.join(' ');
}

// --- basic shapes -> path ---------------------------------------------------

export type GetProp = (name: string) => string | undefined;

function num(get: GetProp, name: string, def = 0): number {
  const v = get(name);
  if (v == null) return def;
  const n = parseFloat(v);
  return Number.isNaN(n) ? def : n;
}

function hasProp(get: GetProp, name: string): boolean {
  const v = get(name);
  return v != null && v !== '';
}

function parsePoints(s: string | undefined): number[] {
  if (!s) return [];
  // `points` coordinates follow the same number grammar as path data: the sign
  // doubles as a separator ("5-5") and decimals/exponents may be packed.
  return tokenizeNumbers(s);
}

/**
 * Convert a basic shape to path data. `get` reads a geometry property from the
 * element's attributes or inline style. Returns the `d` string, or null if the
 * shape is degenerate / unsupported.
 */
export function shapeToPathData(tag: string, get: GetProp, precision: number): string | null {
  const f = (n: number) => formatNumber(n, precision);
  switch (tag) {
    case 'rect': {
      const x = num(get, 'x'), y = num(get, 'y');
      const w = num(get, 'width'), h = num(get, 'height');
      if (w <= 0 || h <= 0) return null;
      let rx = hasProp(get, 'rx') ? num(get, 'rx') : NaN;
      let ry = hasProp(get, 'ry') ? num(get, 'ry') : NaN;
      if (Number.isNaN(rx) && Number.isNaN(ry)) { rx = 0; ry = 0; }
      else if (Number.isNaN(rx)) rx = ry;
      else if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), w / 2);
      ry = Math.min(Math.max(ry, 0), h / 2);
      if (rx === 0 || ry === 0) {
        return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
      }
      return `M${f(x + rx)} ${f(y)}`
        + `H${f(x + w - rx)}`
        + `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}`
        + `V${f(y + h - ry)}`
        + `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}`
        + `H${f(x + rx)}`
        + `A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}`
        + `V${f(y + ry)}`
        + `A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z`;
    }
    case 'circle': {
      const cx = num(get, 'cx'), cy = num(get, 'cy'), r = num(get, 'r');
      if (r <= 0) return null;
      return `M${f(cx - r)} ${f(cy)}`
        + `A${f(r)} ${f(r)} 0 1 0 ${f(cx + r)} ${f(cy)}`
        + `A${f(r)} ${f(r)} 0 1 0 ${f(cx - r)} ${f(cy)}Z`;
    }
    case 'ellipse': {
      const cx = num(get, 'cx'), cy = num(get, 'cy');
      const rx = num(get, 'rx'), ry = num(get, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${f(cx - rx)} ${f(cy)}`
        + `A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}`
        + `A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
    }
    case 'line': {
      const x1 = num(get, 'x1'), y1 = num(get, 'y1');
      const x2 = num(get, 'x2'), y2 = num(get, 'y2');
      return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
    }
    case 'polyline':
    case 'polygon': {
      const pts = parsePoints(get('points'));
      if (pts.length < 4) return null;
      let dd = `M${f(pts[0])} ${f(pts[1])}`;
      for (let i = 2; i + 1 < pts.length; i += 2) dd += `L${f(pts[i])} ${f(pts[i + 1])}`;
      if (tag === 'polygon') dd += 'Z';
      return dd;
    }
    default:
      return null;
  }
}

/** Geometry attributes that define a basic shape (dropped when converting to <path>). */
export const SHAPE_GEOMETRY_ATTRS: Record<string, string[]> = {
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  path: ['d'],
};

export const BASIC_SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);
