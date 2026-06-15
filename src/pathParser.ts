// SVG path data parser.
//
// Parses the contents of a <path d="..."> attribute into a flat list of
// segments. Each segment keeps:
//   * the source text ranges of its command letter and numeric arguments
//     (offsets relative to the start of the `d` string) so callers can map
//     back to document positions for syntax highlighting;
//   * the absolute user-space coordinates of every point it produces
//     (end point + control points, including the implicit reflected control
//     points of S/T) so callers can render geometry without re-walking.

export interface Arg {
  /** Raw source text of the number (e.g. "-1.5", ".5", "1e3"). */
  raw: string;
  value: number;
  /** Offset of the first character within the `d` string. */
  start: number;
  /** Offset just past the last character within the `d` string. */
  end: number;
  isFlag: boolean;
}

export interface PathPoint {
  role: 'endpoint' | 'control';
  /** Absolute user-space coordinates. */
  x: number;
  y: number;
  /** Source range within the `d` string; -1/-1 for implicit points. */
  start: number;
  end: number;
  /** Whether this point has explicit coordinates in the source text. */
  hasSource: boolean;
}

export interface Handle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Segment {
  /** Command type, uppercased: M L H V C S Q T A Z. */
  upper: string;
  relative: boolean;
  /** Effective command letter with original case (e.g. "l" for an implicit relative lineto). */
  letter: string;
  /** Was the command letter actually written for this segment? (false for implicit repeats) */
  explicit: boolean;
  /** Source range of the whole segment (command + args) within the `d` string. */
  start: number;
  end: number;
  /** Source range of the command letter; -1/-1 when implicit. */
  letterStart: number;
  letterEnd: number;
  args: Arg[];
  /** End point + control points (incl. reflected ones for S/T), in source order. */
  points: PathPoint[];
  /** Anchor→control handle lines, in absolute coordinates. */
  handles: Handle[];
  /** Current point before this segment. */
  absStart: { x: number; y: number };
  /** Current point after this segment. */
  absEnd: { x: number; y: number };
  /** Explicit control points only, absolute (for coordinate conversion). */
  controlAbs: { x: number; y: number }[];
}

export interface ParsedPath {
  segments: Segment[];
}

const ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

function isCmd(c: string): boolean {
  return 'MmLlHhVvCcSsQqTtAaZz'.indexOf(c) >= 0;
}

function isWsSep(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === ',';
}

function readNumber(s: string, i: number): { raw: string; end: number } | null {
  const start = i;
  let seenDigit = false;
  let seenDot = false;
  let seenExp = false;
  if (s[i] === '+' || s[i] === '-') i++;
  while (i < s.length) {
    const c = s[i];
    if (c >= '0' && c <= '9') {
      seenDigit = true;
      i++;
    } else if (c === '.' && !seenDot && !seenExp) {
      seenDot = true;
      i++;
    } else if ((c === 'e' || c === 'E') && !seenExp && seenDigit) {
      seenExp = true;
      i++;
      if (s[i] === '+' || s[i] === '-') i++;
    } else {
      break;
    }
  }
  if (!seenDigit) return null;
  return { raw: s.slice(start, i), end: i };
}

function readFlag(s: string, i: number): { raw: string; end: number } | null {
  const c = s[i];
  if (c === '0' || c === '1') return { raw: c, end: i + 1 };
  return null;
}

interface State {
  cx: number;
  cy: number;
  prevUpper: string;
  prevCtrl: { x: number; y: number };
  prevQCtrl: { x: number; y: number };
}

export function parsePath(d: string): ParsedPath {
  const segments: Segment[] = [];
  const n = d.length;
  let i = 0;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let prevUpper = '';
  let prevCtrl = { x: 0, y: 0 };
  let prevQCtrl = { x: 0, y: 0 };

  const skip = () => { while (i < n && isWsSep(d[i])) i++; };

  while (i < n) {
    skip();
    if (i >= n) break;
    if (!isCmd(d[i])) { i++; continue; }

    const letter = d[i];
    const upper0 = letter.toUpperCase();
    const isAbs = letter === upper0;
    const lStart = i;
    i++;
    const lEnd = i;

    if (upper0 === 'Z') {
      segments.push({
        upper: 'Z', relative: !isAbs, letter, explicit: true,
        start: lStart, end: lEnd, letterStart: lStart, letterEnd: lEnd,
        args: [],
        points: [{ role: 'endpoint', x: sx, y: sy, start: -1, end: -1, hasSource: false }],
        handles: [], absStart: { x: cx, y: cy }, absEnd: { x: sx, y: sy }, controlAbs: [],
      });
      cx = sx; cy = sy; prevUpper = 'Z';
      continue;
    }

    // Read one or more argument groups; after the first, an implicit command
    // of the same letter is assumed (M/m promotes following groups to L/l).
    let group = 0;
    for (;;) {
      const save = i;
      skip();
      if (i >= n || isCmd(d[i])) { i = save; break; }

      const eff = group === 0 ? upper0 : (upper0 === 'M' ? 'L' : upper0);
      const cnt = ARG_COUNT[eff];
      const args: Arg[] = [];
      let ok = true;
      for (let k = 0; k < cnt; k++) {
        skip();
        const isFlag = eff === 'A' && (k === 3 || k === 4);
        const r = isFlag ? readFlag(d, i) : readNumber(d, i);
        if (!r) { ok = false; break; }
        args.push({ raw: r.raw, value: parseFloat(r.raw), start: i, end: r.end, isFlag });
        i = r.end;
      }
      if (!ok) { i = save; break; }

      const effLetter = isAbs ? eff : eff.toLowerCase();
      const explicit = group === 0;
      const state: State = { cx, cy, prevUpper, prevCtrl, prevQCtrl };
      const seg = buildSegment(eff, isAbs, args, state, effLetter, explicit,
        explicit ? lStart : -1, explicit ? lEnd : -1);
      segments.push(seg);

      cx = seg.absEnd.x;
      cy = seg.absEnd.y;
      if (eff === 'M') { sx = cx; sy = cy; }
      if (eff === 'C' || eff === 'S') {
        prevCtrl = seg.controlAbs[seg.controlAbs.length - 1];
      } else if (eff === 'Q') {
        prevQCtrl = seg.controlAbs[0];
      } else if (eff === 'T') {
        const rc = seg.points[0];
        prevQCtrl = { x: rc.x, y: rc.y };
      }
      prevUpper = eff;
      group++;
    }
  }

  return { segments };
}

function buildSegment(
  eff: string, isAbs: boolean, args: Arg[], st: State,
  letter: string, explicit: boolean, lStart: number, lEnd: number,
): Segment {
  const cx = st.cx, cy = st.cy;

  const pair = (idx: number) => {
    const ax = args[idx], ay = args[idx + 1];
    return {
      x: isAbs ? ax.value : cx + ax.value,
      y: isAbs ? ay.value : cy + ay.value,
      start: ax.start,
      end: ay.end,
    };
  };
  const endpoint = (p: { x: number; y: number; start: number; end: number }): PathPoint =>
    ({ role: 'endpoint', x: p.x, y: p.y, start: p.start, end: p.end, hasSource: true });
  const control = (p: { x: number; y: number; start: number; end: number }): PathPoint =>
    ({ role: 'control', x: p.x, y: p.y, start: p.start, end: p.end, hasSource: true });

  const points: PathPoint[] = [];
  const handles: Handle[] = [];
  const controlAbs: { x: number; y: number }[] = [];
  let absEnd = { x: cx, y: cy };

  switch (eff) {
    case 'M':
    case 'L': {
      const p = pair(0);
      absEnd = { x: p.x, y: p.y };
      points.push(endpoint(p));
      break;
    }
    case 'H': {
      const a = args[0];
      const x = isAbs ? a.value : cx + a.value;
      absEnd = { x, y: cy };
      points.push({ role: 'endpoint', x, y: cy, start: a.start, end: a.end, hasSource: true });
      break;
    }
    case 'V': {
      const a = args[0];
      const y = isAbs ? a.value : cy + a.value;
      absEnd = { x: cx, y };
      points.push({ role: 'endpoint', x: cx, y, start: a.start, end: a.end, hasSource: true });
      break;
    }
    case 'C': {
      const c1 = pair(0), c2 = pair(2), e = pair(4);
      controlAbs.push({ x: c1.x, y: c1.y }, { x: c2.x, y: c2.y });
      absEnd = { x: e.x, y: e.y };
      points.push(control(c1), control(c2), endpoint(e));
      handles.push({ x1: cx, y1: cy, x2: c1.x, y2: c1.y }, { x1: e.x, y1: e.y, x2: c2.x, y2: c2.y });
      break;
    }
    case 'S': {
      const c2 = pair(0), e = pair(2);
      const refl = (st.prevUpper === 'C' || st.prevUpper === 'S')
        ? { x: 2 * cx - st.prevCtrl.x, y: 2 * cy - st.prevCtrl.y }
        : { x: cx, y: cy };
      controlAbs.push({ x: c2.x, y: c2.y });
      absEnd = { x: e.x, y: e.y };
      points.push(
        { role: 'control', x: refl.x, y: refl.y, start: -1, end: -1, hasSource: false },
        control(c2),
        endpoint(e),
      );
      handles.push({ x1: cx, y1: cy, x2: refl.x, y2: refl.y }, { x1: e.x, y1: e.y, x2: c2.x, y2: c2.y });
      break;
    }
    case 'Q': {
      const c = pair(0), e = pair(2);
      controlAbs.push({ x: c.x, y: c.y });
      absEnd = { x: e.x, y: e.y };
      points.push(control(c), endpoint(e));
      handles.push({ x1: cx, y1: cy, x2: c.x, y2: c.y }, { x1: e.x, y1: e.y, x2: c.x, y2: c.y });
      break;
    }
    case 'T': {
      const e = pair(0);
      const refl = (st.prevUpper === 'Q' || st.prevUpper === 'T')
        ? { x: 2 * cx - st.prevQCtrl.x, y: 2 * cy - st.prevQCtrl.y }
        : { x: cx, y: cy };
      absEnd = { x: e.x, y: e.y };
      points.push(
        { role: 'control', x: refl.x, y: refl.y, start: -1, end: -1, hasSource: false },
        endpoint(e),
      );
      handles.push({ x1: cx, y1: cy, x2: refl.x, y2: refl.y }, { x1: e.x, y1: e.y, x2: refl.x, y2: refl.y });
      break;
    }
    case 'A': {
      const e = isAbs
        ? { x: args[5].value, y: args[6].value }
        : { x: cx + args[5].value, y: cy + args[6].value };
      absEnd = { x: e.x, y: e.y };
      points.push({ role: 'endpoint', x: e.x, y: e.y, start: args[5].start, end: args[6].end, hasSource: true });
      break;
    }
  }

  const start = explicit ? lStart : args[0].start;
  const end = args.length ? args[args.length - 1].end : lEnd;

  return {
    upper: eff, relative: !isAbs, letter, explicit,
    start, end, letterStart: lStart, letterEnd: lEnd,
    args, points, handles,
    absStart: { x: cx, y: cy }, absEnd, controlAbs,
  };
}
