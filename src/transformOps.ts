// The four "transform" operations available when the cursor is on a transform
// attribute value:
//   toMatrix      - convert this element's transform to matrix()
//   toMatrixDeep  - ... and every nested transform too
//   resolve       - bake this transform into geometry (shapes -> <path>), one level
//   resolveDeep   - ... recursively flatten the whole subtree (no transforms left)

import { Matrix, IDENTITY, multiply, isIdentity, parseTransformList, matrixToString } from './matrix';
import { bakePathData, shapeToPathData, SHAPE_GEOMETRY_ATTRS, BASIC_SHAPES } from './svgGeometry';
import {
  SNode, Attr, parseXml, elementAt, getAttr, transformElementAt,
  inlineStyle, geomProp, descendantElements, directChildElements,
} from './svgTree';

export type OpKind = 'toMatrix' | 'toMatrixDeep' | 'resolve' | 'resolveDeep';

export interface TextEdit { start: number; end: number; text: string; }

const CONTAINER_TAGS = new Set(['g', 'a', 'switch']);

function transformOf(el: SNode): Matrix | null {
  const a = getAttr(el, 'transform');
  if (!a || !a.hasValue || !a.value.trim()) return null;
  return parseTransformList(a.value);
}

function valueEdit(attr: Attr, text: string): TextEdit {
  return { start: attr.valueStart, end: attr.valueEnd, text };
}

function deleteAttrEdit(src: string, attr: Attr): TextEdit {
  let start = attr.nameStart;
  if (start > 0 && /\s/.test(src[start - 1])) start -= 1; // swallow one leading space
  return { start, end: attr.end, text: '' };
}

function addTransformEdit(el: SNode, value: string): TextEdit {
  const pos = el.start + 1 + (el.tag ? el.tag.length : 0);
  return { start: pos, end: pos, text: ` transform="${value}"` };
}

function innerRange(el: SNode): [number, number] {
  return [el.openEnd, el.innerEnd]; // innerEnd = start of the close tag (or end, for unclosed)
}

function hasMeaningfulChildren(el: SNode, src: string): boolean {
  return el.children.some((c) =>
    c.type === 'element' || c.type === 'cdata'
    || (c.type === 'text' && src.slice(c.start, c.end).trim() !== ''));
}

/** Reconstruct a start tag, optionally dropping/replacing transform and dropping geometry attrs. */
function startTag(el: SNode, src: string, opts: {
  tag?: string; dropTransform?: boolean; setTransform?: string;
  dropAttrs?: Set<string>; addAttrs?: string; selfClose?: boolean;
}): string {
  const tag = opts.tag || el.tag;
  let s = '<' + tag;
  for (const a of el.attrs) {
    if (a.name === 'transform') {
      if (opts.dropTransform) continue;
      if (opts.setTransform != null) { s += ` transform="${opts.setTransform}"`; continue; }
    }
    if (opts.dropAttrs && opts.dropAttrs.has(a.name)) continue;
    s += ' ' + src.slice(a.nameStart, a.end);
  }
  if (opts.addAttrs) s += ' ' + opts.addAttrs;
  s += opts.selfClose ? '/>' : '>';
  return s;
}

/** Turn a shape (or path) element into a transform-free <path>, baking matrix m. Returns null if degenerate. */
function shapeToPathText(el: SNode, src: string, m: Matrix, precision: number): string | null {
  const tag = el.tag!;
  let d: string | null;
  if (tag === 'path') {
    const a = getAttr(el, 'd');
    const d0 = a && a.hasValue ? a.value : '';
    d = isIdentity(m) ? d0 : bakePathData(d0, m, precision);
  } else {
    const style = inlineStyle(el);
    const d0 = shapeToPathData(tag, (n) => geomProp(el, style, n), precision);
    if (d0 == null) return null;
    d = isIdentity(m) ? d0 : bakePathData(d0, m, precision);
  }
  const drop = new Set([...(SHAPE_GEOMETRY_ATTRS[tag] || []), 'transform']);
  const hasKids = hasMeaningfulChildren(el, src);
  const open = startTag(el, src, { tag: 'path', dropTransform: true, dropAttrs: drop, addAttrs: `d="${d}"`, selfClose: !hasKids });
  if (!hasKids) return open;
  const [is, ie] = innerRange(el);
  return open + src.slice(is, ie) + (el.closed ? '</path>' : '');
}

/** op 3: resolve the target's own transform, pushing it one level into direct children. */
function resolveOne(el: SNode, src: string, m: Matrix, precision: number): TextEdit[] | null {
  const tag = el.tag!;
  if (BASIC_SHAPES.has(tag)) {
    const replaced = shapeToPathText(el, src, m, precision);
    if (replaced == null) return null;
    return [{ start: el.start, end: el.end, text: replaced }];
  }

  // Container: drop our transform, push m onto each direct child.
  const edits: TextEdit[] = [];
  const ta = getAttr(el, 'transform');
  if (ta) edits.push(deleteAttrEdit(src, ta));
  const mStr = matrixToString(m, precision);

  for (const child of directChildElements(el)) {
    const mc = transformOf(child);
    if (BASIC_SHAPES.has(child.tag!) && !mc) {
      const replaced = shapeToPathText(child, src, m, precision);
      if (replaced != null) { edits.push({ start: child.start, end: child.end, text: replaced }); continue; }
    }
    const ca = getAttr(child, 'transform');
    if (ca && ca.hasValue) edits.push(valueEdit(ca, `${mStr} ${ca.value}`));
    else edits.push(addTransformEdit(child, mStr));
  }
  return edits;
}

/** op 4: recursively flatten a subtree so no transforms remain (shapes -> baked paths). */
function flatten(el: SNode, src: string, acc: Matrix, precision: number): string {
  const tag = el.tag!;
  const own = transformOf(el);
  const m = own ? multiply(acc, own) : acc;

  if (BASIC_SHAPES.has(tag)) {
    const t = shapeToPathText(el, src, m, precision);
    if (t != null) return t;
    // degenerate: keep element, drop transform
    return rebuildVerbatim(el, src, { dropTransform: true });
  }

  if (CONTAINER_TAGS.has(tag)) {
    if (el.selfClosing) return startTag(el, src, { dropTransform: true, selfClose: true });
    let inner = '';
    for (const ch of el.children) {
      inner += ch.type === 'element' ? flatten(ch, src, m, precision) : src.slice(ch.start, ch.end);
    }
    return startTag(el, src, { dropTransform: true }) + inner + (el.closed ? `</${tag}>` : '');
  }

  // Opaque element (text, image, use, nested svg, ...): can't bake geometry,
  // so carry the accumulated matrix as its own transform; keep children verbatim.
  return rebuildVerbatim(el, src, { setTransform: isIdentity(m) ? undefined : matrixToString(m, precision), dropTransform: isIdentity(m) });
}

function rebuildVerbatim(el: SNode, src: string, opts: { dropTransform?: boolean; setTransform?: string }): string {
  const open = startTag(el, src, { dropTransform: opts.dropTransform, setTransform: opts.setTransform, selfClose: el.selfClosing });
  if (el.selfClosing) return open;
  const [is, ie] = innerRange(el);
  return open + src.slice(is, ie) + (el.closed ? `</${el.tag}>` : '');
}

function resolveDeep(el: SNode, src: string, _m: Matrix, precision: number): TextEdit[] {
  const text = flatten(el, src, IDENTITY, precision);
  return [{ start: el.start, end: el.end, text }];
}

function toMatrixDeep(el: SNode, precision: number): TextEdit[] {
  const edits: TextEdit[] = [];
  for (const e of [el, ...descendantElements(el)]) {
    const a = getAttr(e, 'transform');
    if (a && a.hasValue && a.value.trim()) {
      edits.push(valueEdit(a, matrixToString(parseTransformList(a.value), precision)));
    }
  }
  return edits;
}

/**
 * Structural check whether the offset range is on a real element's `transform`
 * attribute value (matches when the four commands would actually apply, so the
 * menu never appears for `transform="…"` text inside comments/CDATA/content).
 */
export function cursorOnTransform(text: string, from: number, to = from): boolean {
  return !!transformElementAt(parseXml(text), from, to);
}

/** Build the edits for an operation, or null if not applicable. */
export function buildTransformEdits(text: string, from: number, to: number, kind: OpKind, precision: number): TextEdit[] | null {
  const root = parseXml(text);
  const hit = transformElementAt(root, from, to);
  const el = hit ? hit.el : elementAt(root, from);
  if (!el || el.type !== 'element') return null;
  const m = transformOf(el);
  if (!m) return null;

  switch (kind) {
    case 'toMatrix': {
      const a = getAttr(el, 'transform')!;
      return [valueEdit(a, matrixToString(m, precision))];
    }
    case 'toMatrixDeep':
      return toMatrixDeep(el, precision);
    case 'resolve':
      return resolveOne(el, text, m, precision);
    case 'resolveDeep':
      return resolveDeep(el, text, m, precision);
  }
}
