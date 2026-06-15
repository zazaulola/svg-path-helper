// Shared test helpers (not a *.test.ts file, so the runner won't execute it).
import assert from 'node:assert/strict';

export function assertClose(actual: number, expected: number, eps = 1e-6, msg?: string): void {
  assert.ok(Math.abs(actual - expected) <= eps, msg ?? `${actual} !≈ ${expected} (eps ${eps})`);
}

export function applyEdits(text: string, edits: { start: number; end: number; text: string }[] | null): string {
  assert.ok(edits, 'expected edits, got null');
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, e.start) + e.text + text.slice(e.end);
  }
  return text;
}

/** Read a property map as a getter, for shapeToPathData. */
export function getter(o: Record<string, string>): (n: string) => string | undefined {
  return (n: string) => o[n];
}

// --- elliptical-arc sampling (endpoint -> center parametrization, SVG F.6.5) ---

export interface ArcC { cx: number; cy: number; rx: number; ry: number; phi: number; t1: number; dt: number; }

export function arcCenter(x1: number, y1: number, x2: number, y2: number, rx: number, ry: number, phiDeg: number, large: number, sweep: number): ArcC {
  const phi = phiDeg * Math.PI / 180;
  const cos = Math.cos(phi), sin = Math.sin(phi);
  rx = Math.abs(rx); ry = Math.abs(ry);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const sign = large !== sweep ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const d = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    let a = Math.acos(Math.min(1, Math.max(-1, d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, t1, dt };
}

export function arcPoint(c: ArcC, t: number): { x: number; y: number } {
  const th = c.t1 + t * c.dt;
  const cos = Math.cos(c.phi), sin = Math.sin(c.phi);
  const x = c.rx * Math.cos(th), y = c.ry * Math.sin(th);
  return { x: c.cx + cos * x - sin * y, y: c.cy + sin * x + cos * y };
}

export function sampleArc(c: ArcC, n: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= n; i++) pts.push(arcPoint(c, i / n));
  return pts;
}

/** One-sided Hausdorff distance from point set a to b. */
export function hausdorff(a: { x: number; y: number }[], b: { x: number; y: number }[]): number {
  let m = 0;
  for (const p of a) {
    let min = Infinity;
    for (const q of b) min = Math.min(min, Math.hypot(p.x - q.x, p.y - q.y));
    m = Math.max(m, min);
  }
  return m;
}
