// Locating <path> elements and the enclosing <svg> within document text.

import { parsePath, ParsedPath } from './pathParser';

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
 * Tag each `<path>` *that carries a `d` attribute* with `data-sph-idx="N"` so
 * the webview can map an overlay back to the exact rendered element and read
 * its CTM. The population and order must match `findPaths` over the same range
 * exactly — so this scans tags the same way and applies the same `d` filter
 * (a decorative `<path>` without `d` is skipped, not numbered).
 */
export function tagPaths(svg: string): string {
  let out = '';
  let i = 0;
  let n = 0;
  for (;;) {
    const idx = svg.indexOf('<path', i);
    if (idx < 0) { out += svg.slice(i); break; }

    const after = svg[idx + 5];
    if (after !== undefined && !/[\s/>]/.test(after)) {
      out += svg.slice(i, idx + 5);
      i = idx + 5;
      continue;
    }

    let j = idx + 5;
    let quote: string | null = null;
    while (j < svg.length) {
      const c = svg[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }

    const tag = svg.slice(idx, j);
    out += svg.slice(i, idx + 5);            // text up to and including "<path"
    if (D_ATTR.test(tag)) out += ` data-sph-idx="${n++}"`;
    out += svg.slice(idx + 5, j);            // the rest of the start tag
    i = j;
  }
  return out;
}
