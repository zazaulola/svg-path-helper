// A compact, formatting-preserving XML/SVG parser. Produces a tree with source
// ranges so callers can do surgical text edits or reserialize a subtree.

export interface Attr {
  name: string;
  value: string;
  hasValue: boolean;
  nameStart: number;
  nameEnd: number;
  /** Content range inside the quotes (or the unquoted value range). -1 if no value. */
  valueStart: number;
  valueEnd: number;
  quote: string;
  /** Offset just past the whole attribute (past closing quote / value / name). */
  end: number;
}

export interface SNode {
  type: 'element' | 'text' | 'comment' | 'cdata' | 'pi' | 'doctype';
  tag?: string;
  attrs: Attr[];
  children: SNode[];
  /** Start offset of the node. */
  start: number;
  /** End offset (past the node, incl. close tag for elements). */
  end: number;
  /** Offset just past the start tag's `>`. */
  openEnd: number;
  /** Offset where inner content ends (start of the close tag, or = end). */
  innerEnd: number;
  selfClosing: boolean;
  /** Whether a matching close tag was actually found. */
  closed: boolean;
  parent?: SNode;
}

const WS = /\s/;

function parseStartTag(text: string, start: number) {
  let i = start + 1;
  const nameStart = i;
  while (i < text.length && !WS.test(text[i]) && text[i] !== '/' && text[i] !== '>') i++;
  const tag = text.slice(nameStart, i).toLowerCase();
  const attrs: Attr[] = [];
  let selfClosing = false;

  while (i < text.length) {
    while (i < text.length && WS.test(text[i])) i++;
    if (i >= text.length) break;
    if (text[i] === '>') { i++; break; }
    if (text[i] === '/' && text[i + 1] === '>') { selfClosing = true; i += 2; break; }
    if (text[i] === '/') { i++; continue; }

    const anStart = i;
    while (i < text.length && !WS.test(text[i]) && text[i] !== '=' && text[i] !== '/' && text[i] !== '>') i++;
    const anEnd = i;
    const name = text.slice(anStart, anEnd);
    if (!name) { i++; continue; }

    let value = '', hasValue = false, valueStart = -1, valueEnd = -1, quote = '', attrEnd = anEnd;
    let j = i;
    while (j < text.length && WS.test(text[j])) j++;
    if (text[j] === '=') {
      j++;
      while (j < text.length && WS.test(text[j])) j++;
      if (text[j] === '"' || text[j] === "'") {
        quote = text[j];
        valueStart = j + 1;
        const close = text.indexOf(quote, valueStart);
        valueEnd = close < 0 ? text.length : close;
        value = text.slice(valueStart, valueEnd);
        attrEnd = close < 0 ? text.length : close + 1;
        hasValue = true;
      } else {
        // Unquoted value: stop at whitespace, '>', or a self-closing '/>'.
        valueStart = j;
        while (j < text.length && !WS.test(text[j]) && text[j] !== '>' && !(text[j] === '/' && text[j + 1] === '>')) j++;
        valueEnd = j;
        value = text.slice(valueStart, valueEnd);
        attrEnd = j;
        hasValue = true;
      }
      i = attrEnd;
    } else {
      i = anEnd;
    }
    attrs.push({ name, value, hasValue, nameStart: anStart, nameEnd: anEnd, valueStart, valueEnd, quote, end: attrEnd });
  }
  return { tagEnd: i, tag, attrs, selfClosing };
}

function leaf(type: SNode['type'], start: number, end: number): SNode {
  return { type, attrs: [], children: [], start, end, openEnd: end, innerEnd: end, selfClosing: true, closed: true };
}

/** End offset that covers an unclosed element's children. */
function coverEnd(node: SNode): number {
  return node.children.length ? node.children[node.children.length - 1].end : node.openEnd;
}

function finalizeUnclosed(node: SNode): void {
  if (node.closed || node.selfClosing) return;
  node.end = coverEnd(node);
  node.innerEnd = node.end;
}

export function parseXml(text: string): SNode {
  const root: SNode = { type: 'element', tag: '#document', attrs: [], children: [], start: 0, end: text.length, openEnd: 0, innerEnd: text.length, selfClosing: false, closed: true };
  const stack: SNode[] = [root];
  const top = () => stack[stack.length - 1];
  const add = (node: SNode) => { node.parent = top(); top().children.push(node); };
  const n = text.length;
  let i = 0;

  while (i < n) {
    if (text[i] === '<') {
      if (text.startsWith('<!--', i)) {
        const c = text.indexOf('-->', i + 4);
        add(leaf('comment', i, c < 0 ? n : c + 3));
        i = c < 0 ? n : c + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const c = text.indexOf(']]>', i + 9);
        add(leaf('cdata', i, c < 0 ? n : c + 3));
        i = c < 0 ? n : c + 3;
      } else if (text.startsWith('<?', i)) {
        const c = text.indexOf('?>', i + 2);
        add(leaf('pi', i, c < 0 ? n : c + 2));
        i = c < 0 ? n : c + 2;
      } else if (text.startsWith('<!', i)) {
        // DOCTYPE: an internal subset [ ... ] may legally contain '>'.
        let c = text.indexOf('>', i + 2);
        const br = text.indexOf('[', i + 2);
        if (br >= 0 && (c < 0 || br < c)) {
          const rb = text.indexOf(']', br);
          c = text.indexOf('>', rb < 0 ? i + 2 : rb);
        }
        add(leaf('doctype', i, c < 0 ? n : c + 1));
        i = c < 0 ? n : c + 1;
      } else if (text[i + 1] === '/') {
        const closeStart = i;
        const c = text.indexOf('>', i);
        const e = c < 0 ? n : c + 1;
        const closeTag = text.slice(i + 2, c < 0 ? n : c).trim().toLowerCase();
        let idx = -1;
        for (let k = stack.length - 1; k >= 1; k--) {
          if (stack[k].tag === closeTag) { idx = k; break; }
        }
        if (idx >= 0) {
          // Frames above the match were opened but never closed: bound them to their children.
          for (let k = stack.length - 1; k > idx; k--) finalizeUnclosed(stack[k]);
          stack[idx].innerEnd = closeStart;
          stack[idx].end = e;
          stack[idx].closed = true;
          stack.length = idx;
        }
        i = e;
      } else {
        const st = parseStartTag(text, i);
        const node: SNode = {
          type: 'element', tag: st.tag, attrs: st.attrs, children: [],
          start: i, end: st.tagEnd, openEnd: st.tagEnd, innerEnd: st.tagEnd,
          selfClosing: st.selfClosing, closed: st.selfClosing,
        };
        add(node);
        if (!st.selfClosing) stack.push(node);
        i = st.tagEnd;
      }
    } else {
      const lt = text.indexOf('<', i);
      const e = lt < 0 ? n : lt;
      add(leaf('text', i, e));
      i = e;
    }
  }
  // Any elements still open at EOF: bound them to their children (innermost first).
  for (let k = stack.length - 1; k >= 1; k--) finalizeUnclosed(stack[k]);
  return root;
}

/** Deepest element node whose [start,end] contains offset. */
export function elementAt(root: SNode, offset: number): SNode | undefined {
  let best: SNode | undefined;
  const walk = (node: SNode) => {
    for (const ch of node.children) {
      if (ch.type === 'element' && ch.start <= offset && offset <= ch.end) {
        best = ch;
        walk(ch);
      }
    }
  };
  walk(root);
  return best;
}

export function getAttr(el: SNode, name: string): Attr | undefined {
  return el.attrs.find((a) => a.name === name);
}

/** Find the element whose `transform` attribute value contains (or is overlapped by) the offset range. */
export function transformElementAt(root: SNode, from: number, to: number): { el: SNode; attr: Attr } | undefined {
  let found: { el: SNode; attr: Attr } | undefined;
  const walk = (node: SNode) => {
    for (const ch of node.children) {
      if (ch.type !== 'element') continue;
      const a = getAttr(ch, 'transform');
      if (a && a.hasValue && from <= a.valueEnd && to >= a.valueStart) {
        found = { el: ch, attr: a };
      }
      walk(ch);
    }
  };
  walk(root);
  return found;
}

/** Parse an inline `style="..."` into a property map. */
export function inlineStyle(el: SNode): Record<string, string> {
  const a = getAttr(el, 'style');
  const out: Record<string, string> = {};
  if (!a || !a.hasValue) return out;
  for (const decl of a.value.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) continue;
    const k = decl.slice(0, idx).trim();
    const v = decl.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Read a geometry property from attributes, falling back to inline style. */
export function geomProp(el: SNode, style: Record<string, string>, name: string): string | undefined {
  const a = getAttr(el, name);
  if (a && a.hasValue) return a.value;
  if (name in style) return style[name];
  return undefined;
}

export function descendantElements(el: SNode): SNode[] {
  const out: SNode[] = [];
  const walk = (n: SNode) => { for (const c of n.children) if (c.type === 'element') { out.push(c); walk(c); } };
  walk(el);
  return out;
}

export function directChildElements(el: SNode): SNode[] {
  return el.children.filter((c) => c.type === 'element');
}
