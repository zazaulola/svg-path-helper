// Coordinate conversion and absolute-primitive generation for SVG paths.

import { parsePath, Segment } from './pathParser';

/**
 * Convert a `d` string to absolute or relative coordinates.
 * Command kinds are preserved (S stays S, H stays H); only the case of the
 * letters and the numbers change. The very first moveto is always emitted as
 * an absolute `M` (the SVG convention: a leading `m` is treated as absolute).
 */
export function convertD(d: string, mode: 'abs' | 'rel', precision = 6): string {
  const { segments } = parsePath(d);
  const out: string[] = [];
  let firstMoveDone = false;
  for (const seg of segments) {
    const forceAbs = seg.upper === 'M' && !firstMoveDone;
    out.push(mode === 'abs' || forceAbs ? emitAbs(seg, precision) : emitRel(seg, precision));
    if (seg.upper === 'M') firstMoveDone = true;
  }
  return out.join(' ');
}

/** Round to `p` fractional digits and strip trailing zeros / negative zero. */
export function formatNumber(n: number, p: number): string {
  if (!isFinite(n)) n = 0;
  let r = Number(n.toFixed(p));
  if (Object.is(r, -0)) r = 0;
  return String(r);
}

function fmt(n: number, p: number): string {
  return formatNumber(n, p);
}

function emitAbs(seg: Segment, p: number): string {
  const f = (n: number) => fmt(n, p);
  const e = seg.absEnd, c = seg.controlAbs, a = seg.args;
  switch (seg.upper) {
    case 'M': return `M ${f(e.x)} ${f(e.y)}`;
    case 'L': return `L ${f(e.x)} ${f(e.y)}`;
    case 'H': return `H ${f(e.x)}`;
    case 'V': return `V ${f(e.y)}`;
    case 'C': return `C ${f(c[0].x)} ${f(c[0].y)} ${f(c[1].x)} ${f(c[1].y)} ${f(e.x)} ${f(e.y)}`;
    case 'S': return `S ${f(c[0].x)} ${f(c[0].y)} ${f(e.x)} ${f(e.y)}`;
    case 'Q': return `Q ${f(c[0].x)} ${f(c[0].y)} ${f(e.x)} ${f(e.y)}`;
    case 'T': return `T ${f(e.x)} ${f(e.y)}`;
    case 'A': return `A ${a[0].raw} ${a[1].raw} ${a[2].raw} ${a[3].raw} ${a[4].raw} ${f(e.x)} ${f(e.y)}`;
    case 'Z': return 'Z';
  }
  return '';
}

function emitRel(seg: Segment, p: number): string {
  const f = (n: number) => fmt(n, p);
  const e = seg.absEnd, c = seg.controlAbs, a = seg.args, s = seg.absStart;
  switch (seg.upper) {
    case 'M': return `m ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'L': return `l ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'H': return `h ${f(e.x - s.x)}`;
    case 'V': return `v ${f(e.y - s.y)}`;
    case 'C': return `c ${f(c[0].x - s.x)} ${f(c[0].y - s.y)} ${f(c[1].x - s.x)} ${f(c[1].y - s.y)} ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'S': return `s ${f(c[0].x - s.x)} ${f(c[0].y - s.y)} ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'Q': return `q ${f(c[0].x - s.x)} ${f(c[0].y - s.y)} ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'T': return `t ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'A': return `a ${a[0].raw} ${a[1].raw} ${a[2].raw} ${a[3].raw} ${a[4].raw} ${f(e.x - s.x)} ${f(e.y - s.y)}`;
    case 'Z': return 'z';
  }
  return '';
}

/** Full path rendered in absolute coordinates, geometry-exact (S/T expanded to C/Q). */
export function fullAbsoluteD(segments: Segment[]): string {
  return segments.map(absPrim).join(' ');
}

/** A standalone path that renders just `seg` in place (starts with a moveto to its start point). */
export function segmentOverlayD(seg: Segment): string {
  if (seg.upper === 'M') return '';
  if (seg.upper === 'Z') {
    return `M ${seg.absStart.x} ${seg.absStart.y} L ${seg.absEnd.x} ${seg.absEnd.y}`;
  }
  return `M ${seg.absStart.x} ${seg.absStart.y} ${absPrim(seg)}`;
}

function absPrim(seg: Segment): string {
  const e = seg.absEnd, c = seg.controlAbs, a = seg.args;
  switch (seg.upper) {
    case 'M': return `M ${e.x} ${e.y}`;
    case 'L':
    case 'H':
    case 'V': return `L ${e.x} ${e.y}`;
    case 'C': return `C ${c[0].x} ${c[0].y} ${c[1].x} ${c[1].y} ${e.x} ${e.y}`;
    case 'S': { const r = seg.points[0]; return `C ${r.x} ${r.y} ${c[0].x} ${c[0].y} ${e.x} ${e.y}`; }
    case 'Q': return `Q ${c[0].x} ${c[0].y} ${e.x} ${e.y}`;
    case 'T': { const r = seg.points[0]; return `Q ${r.x} ${r.y} ${e.x} ${e.y}`; }
    case 'A': return `A ${a[0].raw} ${a[1].raw} ${a[2].raw} ${a[3].raw} ${a[4].raw} ${e.x} ${e.y}`;
    case 'Z': return 'Z';
  }
  return '';
}
