// Locating <path> elements and the enclosing <svg> within document text.

import { parsePath, ParsedPath } from './pathParser';
import { parseXml, getAttr, descendantElements } from './svgTree';

export interface PathInstance {
  /** Offset of the first character of the `d` attribute value (inside the quotes). */
  dStart: number;
  /** The `d` attribute value text. */
  dText: string;
  parsed: ParsedPath;
}

const D_ATTR = /(^|[\s])d\s*=\s*("([^"]*)"|'([^']*)')/;

/** Find every `<path ... d="...">` element and parse its `d` attribute. */
export function findPaths(text: string): PathInstance[] {
  const res: PathInstance[] = [];
  let i = 0;
  for (;;) {
    const idx = text.indexOf('<path', i);
    if (idx < 0) break;

    // Make sure "<path" is a real element start, not "<pathological".
    const after = text[idx + 5];
    if (after !== undefined && !/[\s/>]/.test(after)) { i = idx + 5; continue; }

    // Find the end of the start tag, respecting quoted attribute values.
    let j = idx + 5;
    let quote: string | null = null;
    while (j < text.length) {
      const c = text[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }

    const tag = text.slice(idx, j);
    const m = D_ATTR.exec(tag);
    if (m) {
      const quoted = m[2];
      const val = m[3] !== undefined ? m[3] : m[4];
      const open = m.index + m[0].indexOf(quoted) + 1; // +1 to skip the opening quote
      res.push({ dStart: idx + open, dText: val, parsed: parsePath(val) });
    }
    i = j + 1;
  }
  return res;
}

export interface SvgRegion {
  svg: string;
  /** Offset of the `<svg` start within the document. */
  start: number;
}

/** Extract the outermost `<svg>...</svg>` from a document, or null if none. */
export function extractSvg(text: string): SvgRegion | null {
  const open = text.search(/<svg[\s>]/i);
  if (open < 0) return null;
  const close = text.toLowerCase().lastIndexOf('</svg>');
  if (close < 0 || close < open) return null;
  return { svg: text.slice(open, close + 6), start: open };
}

/**
 * Tag the rendered SVG so the webview can map back to elements:
 *   - every element gets `data-sph-el="N"` (document order) for element highlight;
 *   - every `<path>` with a `d` attribute additionally gets `data-sph-idx="K"`
 *     (path order) — matching `findPaths`/`svgPaths` order — for the path overlay.
 */
export function tagSvg(svg: string): string {
  const els = descendantElements(parseXml(svg));
  let pathOrd = 0;
  const inserts: { pos: number; text: string }[] = [];
  els.forEach((el, i) => {
    const tag = el.tag || '';
    let attrs = ` data-sph-el="${i}"`;
    const d = getAttr(el, 'd');
    if (tag === 'path' && d && d.hasValue) attrs += ` data-sph-idx="${pathOrd++}"`;
    inserts.push({ pos: el.start + 1 + tag.length, text: attrs });
  });
  inserts.sort((a, b) => b.pos - a.pos); // apply end-to-start to keep offsets valid
  let out = svg;
  for (const ins of inserts) out = out.slice(0, ins.pos) + ins.text + out.slice(ins.pos);
  return out;
}

/** Document-order index (data-sph-el) of the deepest element containing `off`, or -1. */
export function elementIdAt(svg: string, off: number): number {
  const els = descendantElements(parseXml(svg));
  let best = -1;
  els.forEach((el, i) => {
    if (el.start <= off && off <= el.end) best = i; // preorder: last containing == deepest
  });
  return best;
}

/**
 * Path elements (with a `d` attribute) inside the SVG region, in the SAME order
 * tagSvg assigns `data-sph-idx`. Parser-based (skips <path> tokens inside
 * comments/CDATA), so the overlay's path index always matches the rendered DOM.
 */
export function svgPaths(text: string): PathInstance[] {
  const region = extractSvg(text);
  if (!region) return findPaths(text);
  const out: PathInstance[] = [];
  for (const el of descendantElements(parseXml(region.svg))) {
    if (el.tag !== 'path') continue;
    const a = getAttr(el, 'd');
    if (!a || !a.hasValue) continue;
    out.push({ dStart: region.start + a.valueStart, dText: a.value, parsed: parsePath(a.value) });
  }
  return out;
}
