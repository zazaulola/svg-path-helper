import * as vscode from 'vscode';
import { Segment, parsePath } from './pathParser';
import { findPaths, extractSvg, tagSvg, elementIdAt, svgPaths, elementTagPos, PathInstance } from './svgDocument';
import { convertD, fullAbsoluteD, segmentOverlayD, formatNumber } from './pathConverter';
import { buildTransformEdits, cursorOnTransform, OpKind } from './transformOps';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let extCtx: vscode.ExtensionContext;
let panel: vscode.WebviewPanel | undefined;
let lastEditor: vscode.TextEditor | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let ctxTimer: ReturnType<typeof setTimeout> | undefined;
let userClosedPreview = false; // suppress auto-open after a manual dismiss

interface DecTypes {
  command: vscode.TextEditorDecorationType;
  endpoint: vscode.TextEditorDecorationType;
  control: vscode.TextEditorDecorationType;
  segment: vscode.TextEditorDecorationType;
  point: vscode.TextEditorDecorationType;
}
let dec: DecTypes;

// ---------------------------------------------------------------------------
// Overlay payload sent to the webview
// ---------------------------------------------------------------------------

/** Everything needed to splice a dragged point back into the source text. */
interface DragCtx {
  /** Source document the offsets belong to (stale-edit / wrong-file guard). */
  uri: string;
  /** Document version when these offsets were captured. */
  version: number;
  /** Index of the <path> within the rendered SVG (data-sph-idx) for CTM lookup. */
  pathIndex: number;
  /** Document offset of the `d` attribute value. */
  dStart: number;
  /** Length of the `d` attribute value. */
  dLen: number;
  segIndex: number;
  pointIndex: number;
  /** Range of the coordinate within the `d` text to replace. */
  slotStart: number;
  slotEnd: number;
  /** Is the owning segment relative? (then we write a delta from absStart) */
  relative: boolean;
  absX: number;
  absY: number;
  /** Which numbers the slot holds: full pair, x only (H), or y only (V). */
  kind: 'xy' | 'x' | 'y';
}

interface OverlayPoint {
  x: number;
  y: number;
  role: 'endpoint' | 'control';
  selected: boolean;
  drag: DragCtx | null;
}
interface OverlayHandle { x1: number; y1: number; x2: number; y2: number; }
interface OverlayData {
  pathIndex: number;
  pathD: string | null;
  segD: string | null;
  handles: OverlayHandle[];
  points: OverlayPoint[];
  selected: { x: number; y: number } | null;
  /** data-sph-el of the element under the cursor (for element highlight), or -1. */
  elementId: number;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  extCtx = context;
  dec = createDecTypes();

  context.subscriptions.push(
    vscode.commands.registerCommand('svgPathHelper.showPreview', openPreview),
    vscode.commands.registerCommand('svgPathHelper.toAbsolute', () => convertSelection('abs')),
    vscode.commands.registerCommand('svgPathHelper.toRelative', () => convertSelection('rel')),
    vscode.commands.registerCommand('svgPathHelper.transformToMatrix', () => runTransformOp('toMatrix')),
    vscode.commands.registerCommand('svgPathHelper.transformToMatrixDeep', () => runTransformOp('toMatrixDeep')),
    vscode.commands.registerCommand('svgPathHelper.transformResolve', () => runTransformOp('resolve')),
    vscode.commands.registerCommand('svgPathHelper.transformResolveDeep', () => runTransformOp('resolveDeep')),

    vscode.window.onDidChangeActiveTextEditor((ed) => {
      updateDecorations(ed);
      updateTransformContext(ed);
      if (ed && isSvgish(ed.document)) {
        lastEditor = ed;
        maybeAutoOpenPreview(ed);
        updatePreview(true);
      }
    }),

    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor === vscode.window.activeTextEditor) scheduleTransformContext();
      if (!isSvgish(e.textEditor.document)) return;
      updateDecorations(e.textEditor);
      updatePreview(false);
    }),

    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document || !isSvgish(ed.document)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateDecorations(ed);
        updateTransformContext(ed);
        updatePreview(true);
      }, 120);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('svgPathHelper.colors')) {
        recreateDecTypes();
        updateDecorations();
      }
    }),
  );

  updateDecorations();
  updateTransformContext();
  maybeAutoOpenPreview();
}

export function deactivate(): void {
  disposeDecTypes();
}

function previewConfig(): { background: string; showGrid: boolean } {
  return {
    background: cfg<string>('preview.background', 'checker'),
    showGrid: cfg<boolean>('preview.showGrid', true),
  };
}

/** Auto-open the preview beside an `.svg` editor (if enabled, not already open, not dismissed). */
function maybeAutoOpenPreview(editor?: vscode.TextEditor): void {
  if (panel || userClosedPreview || !cfg<boolean>('autoOpenPreview', true)) return;
  const ed = editor ?? vscode.window.activeTextEditor;
  if (ed && ed.document.fileName.toLowerCase().endsWith('.svg')) openPreview();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cfg<T>(key: string, def: T): T {
  return vscode.workspace.getConfiguration('svgPathHelper').get<T>(key, def);
}

function isSvgish(doc: vscode.TextDocument): boolean {
  if (doc.fileName.toLowerCase().endsWith('.svg')) return true;
  return ['svg', 'xml', 'xhtml', 'html'].includes(doc.languageId);
}

function getTargetEditor(): vscode.TextEditor | undefined {
  const active = vscode.window.activeTextEditor;
  if (active && isSvgish(active.document)) { lastEditor = active; return active; }
  if (lastEditor && vscode.window.visibleTextEditors.includes(lastEditor) && isSvgish(lastEditor.document)) {
    return lastEditor;
  }
  const visible = vscode.window.visibleTextEditors.find((e) => isSvgish(e.document));
  if (visible) { lastEditor = visible; return visible; }
  return undefined;
}

// ---------------------------------------------------------------------------
// Decorations
// ---------------------------------------------------------------------------

function createDecTypes(): DecTypes {
  return {
    command: vscode.window.createTextEditorDecorationType({
      color: cfg('colors.command', '#4fc1ff'),
      fontWeight: 'bold',
    }),
    endpoint: vscode.window.createTextEditorDecorationType({
      color: cfg('colors.endpoint', '#e8d44d'),
    }),
    control: vscode.window.createTextEditorDecorationType({
      color: cfg('colors.control', '#6a9955'),
    }),
    segment: vscode.window.createTextEditorDecorationType({
      backgroundColor: cfg('colors.segmentBg', 'rgba(120,170,255,0.13)'),
      borderRadius: '2px',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
    point: vscode.window.createTextEditorDecorationType({
      backgroundColor: cfg('colors.pointBg', 'rgba(255,220,0,0.30)'),
      fontWeight: 'bold',
      border: '1px solid rgba(255,220,0,0.85)',
      borderRadius: '2px',
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    }),
  };
}

function disposeDecTypes(): void {
  if (!dec) return;
  Object.values(dec).forEach((d) => d.dispose());
}

function recreateDecTypes(): void {
  disposeDecTypes();
  dec = createDecTypes();
}

function rng(doc: vscode.TextDocument, a: number, b: number): vscode.Range {
  return new vscode.Range(doc.positionAt(a), doc.positionAt(b));
}

/**
 * Push decoration range(s) for [a,b). A range that crosses line breaks (a
 * multi-line `d`) is split per line with leading/trailing whitespace trimmed, so
 * the highlight covers only the actual tokens — never a newline or indentation.
 */
function pushClipped(out: vscode.Range[], doc: vscode.TextDocument, a: number, b: number): void {
  if (b <= a) return;
  const sp = doc.positionAt(a);
  const ep = doc.positionAt(b);
  if (sp.line === ep.line) { out.push(new vscode.Range(sp, ep)); return; }
  for (let line = sp.line; line <= ep.line; line++) {
    const t = doc.lineAt(line).text;
    let lo = line === sp.line ? sp.character : 0;
    let hi = line === ep.line ? ep.character : t.length;
    while (lo < hi && /\s/.test(t[lo])) lo++;
    while (hi > lo && /\s/.test(t[hi - 1])) hi--;
    if (hi > lo) out.push(new vscode.Range(new vscode.Position(line, lo), new vscode.Position(line, hi)));
  }
}

function findSegAt(segs: Segment[], rel: number): Segment | undefined {
  if (rel < 0) return undefined;
  for (const s of segs) if (rel >= s.start && rel <= s.end) return s;
  // Cursor sits in the whitespace between segments: take the last one before it.
  let cand: Segment | undefined;
  for (const s of segs) {
    if (s.start <= rel) cand = s;
    else break;
  }
  return cand;
}

function updateDecorations(editor?: vscode.TextEditor): void {
  editor = editor ?? vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;

  if (!isSvgish(doc)) {
    editor.setDecorations(dec.command, []);
    editor.setDecorations(dec.endpoint, []);
    editor.setDecorations(dec.control, []);
    editor.setDecorations(dec.segment, []);
    editor.setDecorations(dec.point, []);
    return;
  }

  const text = doc.getText();
  const paths = findPaths(text);
  const offsets = editor.selections.map((s) => doc.offsetAt(s.active));

  const cmdR: vscode.Range[] = [];
  const endR: vscode.Range[] = [];
  const ctlR: vscode.Range[] = [];
  const segR: vscode.Range[] = [];
  const ptR: vscode.Range[] = [];

  for (const p of paths) {
    for (const seg of p.parsed.segments) {
      if (seg.explicit && seg.letterStart >= 0) {
        cmdR.push(rng(doc, p.dStart + seg.letterStart, p.dStart + seg.letterEnd));
      }
      for (const pt of seg.points) {
        if (!pt.hasSource) continue;
        pushClipped(pt.role === 'endpoint' ? endR : ctlR, doc, p.dStart + pt.start, p.dStart + pt.end);
      }
    }

    for (const off of offsets) {
      const rel = off - p.dStart;
      if (rel < 0 || rel > p.dText.length) continue;
      const seg = findSegAt(p.parsed.segments, rel);
      if (!seg) continue;
      pushClipped(segR, doc, p.dStart + seg.start, p.dStart + seg.end);
      const pt = seg.points.find((pp) => pp.hasSource && rel >= pp.start && rel <= pp.end);
      if (pt) pushClipped(ptR, doc, p.dStart + pt.start, p.dStart + pt.end);
    }
  }

  editor.setDecorations(dec.command, cmdR);
  editor.setDecorations(dec.endpoint, endR);
  editor.setDecorations(dec.control, ctlR);
  editor.setDecorations(dec.segment, segR);
  editor.setDecorations(dec.point, ptR);
}

// ---------------------------------------------------------------------------
// Preview webview
// ---------------------------------------------------------------------------

function openPreview(): void {
  userClosedPreview = false; // explicit open clears the auto-open suppression
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside, true);
    updatePreview(true);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'svgPathHelper.preview',
    'SVG Preview',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extCtx.extensionUri, 'media')],
    },
  );
  panel.webview.html = getHtml(panel.webview);
  panel.onDidDispose(() => { panel = undefined; userClosedPreview = true; }, null, extCtx.subscriptions);
  panel.webview.onDidReceiveMessage(handleWebviewMessage);
}

function pointKind(upper: string): 'xy' | 'x' | 'y' {
  if (upper === 'H') return 'x';
  if (upper === 'V') return 'y';
  return 'xy';
}

interface DocRef { uri: string; version: number; }

function makePoints(
  p: PathInstance, pathIndex: number, segIndex: number, seg: Segment,
  selectedIdx: number, doc: DocRef,
): OverlayPoint[] {
  return seg.points.map((pp, idx) => ({
    x: pp.x,
    y: pp.y,
    role: pp.role,
    selected: idx === selectedIdx,
    drag: pp.hasSource
      ? {
          uri: doc.uri,
          version: doc.version,
          pathIndex,
          dStart: p.dStart,
          dLen: p.dText.length,
          segIndex,
          pointIndex: idx,
          slotStart: pp.start,
          slotEnd: pp.end,
          relative: seg.relative,
          absX: seg.absStart.x,
          absY: seg.absStart.y,
          kind: pointKind(seg.upper),
        }
      : null,
  }));
}

function overlayForSegment(
  p: PathInstance, pathIndex: number, segIndex: number, selectedIdx: number, doc: DocRef,
): OverlayData {
  const segs = p.parsed.segments;
  const pathD = segs.length ? fullAbsoluteD(segs) : null;
  const seg = segs[segIndex];
  if (!seg) return { pathIndex, pathD, segD: null, handles: [], points: [], selected: null, elementId: -1 };
  const sp = selectedIdx >= 0 ? seg.points[selectedIdx] : undefined;
  return {
    pathIndex,
    pathD,
    segD: segmentOverlayD(seg),
    handles: seg.handles.map((h) => ({ x1: h.x1, y1: h.y1, x2: h.x2, y2: h.y2 })),
    points: makePoints(p, pathIndex, segIndex, seg, selectedIdx, doc),
    selected: sp && sp.hasSource ? { x: sp.x, y: sp.y } : null,
    elementId: -1,
  };
}

function overlayForCursor(p: PathInstance, pathIndex: number, rel: number, doc: DocRef): OverlayData {
  const segs = p.parsed.segments;
  const seg = findSegAt(segs, rel);
  if (!seg) {
    return {
      pathIndex,
      pathD: segs.length ? fullAbsoluteD(segs) : null,
      segD: null, handles: [], points: [], selected: null, elementId: -1,
    };
  }
  const segIndex = segs.indexOf(seg);
  const selectedIdx = seg.points.findIndex((pp) => pp.hasSource && rel >= pp.start && rel <= pp.end);
  return overlayForSegment(p, pathIndex, segIndex, selectedIdx, doc);
}

function infoText(p: PathInstance | undefined, seg: Segment | undefined, selected: boolean): string {
  if (!p) return 'No <path> under cursor';
  if (!seg) return 'Current path highlighted';
  const names: Record<string, string> = {
    M: 'moveto', L: 'lineto', H: 'horizontal lineto', V: 'vertical lineto',
    C: 'cubic Bézier', S: 'smooth cubic', Q: 'quadratic Bézier', T: 'smooth quadratic',
    A: 'elliptical arc', Z: 'closepath',
  };
  const mode = seg.relative ? 'relative' : 'absolute';
  let s = `${seg.letter}  ·  ${names[seg.upper] ?? seg.upper}  ·  ${mode}`;
  if (selected) s += '  ·  point selected (drag to edit)';
  return s;
}

function updatePreview(render: boolean): void {
  if (!panel) return;
  const editor = getTargetEditor();
  if (!editor) return;
  const doc = editor.document;
  const text = doc.getText();
  const region = extractSvg(text);
  const off = doc.offsetAt(editor.selection.active);

  if (render) {
    panel.webview.postMessage({
      type: 'render', svg: region ? tagSvg(region.svg) : '', config: previewConfig(),
      uri: doc.uri.toString(), version: doc.version,
    });
  }

  const paths = svgPaths(text);

  let cur: PathInstance | undefined;
  let curIdx = -1;
  let curRel = -1;
  for (let k = 0; k < paths.length; k++) {
    const rel = off - paths[k].dStart;
    if (rel >= 0 && rel <= paths[k].dText.length) { cur = paths[k]; curIdx = k; curRel = rel; break; }
  }
  // No cursor inside a path: still outline the first path so the panel isn't blank.
  if (!cur && paths.length) { cur = paths[0]; curIdx = 0; curRel = -1; }

  const docRef: DocRef = { uri: doc.uri.toString(), version: doc.version };
  const data: OverlayData = cur
    ? overlayForCursor(cur, curIdx, curRel, docRef)
    : { pathIndex: -1, pathD: null, segD: null, handles: [], points: [], selected: null, elementId: -1 };

  // Element under the cursor (any tag) for the element highlight.
  if (region) {
    const rel = off - region.start;
    if (rel >= 0 && rel <= region.svg.length) data.elementId = elementIdAt(region.svg, rel);
  }
  panel.webview.postMessage({ type: 'overlay', data });

  const seg = cur ? findSegAt(cur.parsed.segments, curRel) : undefined;
  panel.webview.postMessage({ type: 'info', text: infoText(cur, seg, !!data.selected) });
}

// ---------------------------------------------------------------------------
// Dragging points in the preview
// ---------------------------------------------------------------------------

function formatCoord(ctx: DragCtx, x: number, y: number, p: number): string {
  const f = (n: number) => formatNumber(n, p);
  const vx = ctx.relative ? x - ctx.absX : x;
  const vy = ctx.relative ? y - ctx.absY : y;
  if (ctx.kind === 'x') return f(vx);
  if (ctx.kind === 'y') return f(vy);
  return `${f(vx)} ${f(vy)}`;
}

function isNonNegInt(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** Splice a dragged coordinate into the current `d` text. Returns null if unchanged or out of range. */
function spliceDrag(ctx: DragCtx, x: number, y: number, text: string): { baseD: string; newD: string } | null {
  // Validate the (webview-supplied) offsets defensively before touching text.
  if (!isNonNegInt(ctx.dStart) || !isNonNegInt(ctx.dLen)) return null;
  if (ctx.dStart + ctx.dLen > text.length) return null;
  const baseD = text.slice(ctx.dStart, ctx.dStart + ctx.dLen);
  if (!isNonNegInt(ctx.slotStart) || !isNonNegInt(ctx.slotEnd)) return null;
  if (ctx.slotStart > ctx.slotEnd || ctx.slotEnd > baseD.length) return null;
  if (typeof x !== 'number' || typeof y !== 'number' || !isFinite(x) || !isFinite(y)) return null;
  const coord = formatCoord(ctx, x, y, cfg('precision', 6));
  const newD = baseD.slice(0, ctx.slotStart) + coord + baseD.slice(ctx.slotEnd);
  return { baseD, newD };
}

/** Resolve a visible editor by URI, only if its document is still at `version`. */
function editorForDoc(uri: string, version: number): vscode.TextEditor | undefined {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri);
  if (!editor || editor.document.version !== version) return undefined; // stale — bail
  return editor;
}

/** Resolve the editor a drag belongs to, only if the document is unchanged since capture. */
function editorForDrag(ctx: DragCtx): vscode.TextEditor | undefined {
  return editorForDoc(ctx.uri, ctx.version);
}

function handleWebviewMessage(msg: any): void {
  if (!msg) return;
  if (msg.type === 'ready') { updatePreview(true); return; }
  if (msg.type === 'dragMove') { onDragMove(msg.ctx as DragCtx, msg.x, msg.y); return; }
  if (msg.type === 'dragEnd') { void onDragEnd(msg.ctx as DragCtx, msg.x, msg.y); return; }
  if (msg.type === 'selectElement') { selectElementInEditor(msg.id, msg.uri, msg.version); return; }
}

/** Move the editor cursor to the start tag of the element with data-sph-el `id`. */
function selectElementInEditor(id: number, uri: string, version: number): void {
  if (typeof id !== 'number' || id < 0) return;
  const editor = editorForDoc(uri, version); // bail if the previewed text has since changed
  if (!editor) return;
  const doc = editor.document;
  const pos = elementTagPos(doc.getText(), id);
  if (!pos) return;
  const start = doc.positionAt(pos.start + 1); // just after '<'
  const end = doc.positionAt(pos.start + 1 + pos.tag.length);
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(start, end);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function onDragMove(ctx: DragCtx, x: number, y: number): void {
  if (!panel || !ctx) return;
  const editor = editorForDrag(ctx);
  if (!editor) return;
  const doc = editor.document;
  const spliced = spliceDrag(ctx, x, y, doc.getText());
  if (!spliced) return;

  // Re-parse the would-be `d` so the overlay & shape reflect the drag exactly,
  // without touching the document (a single undo step is committed on drop).
  const inst: PathInstance = { dStart: ctx.dStart, dText: spliced.newD, parsed: parsePath(spliced.newD) };
  const docRef: DocRef = { uri: ctx.uri, version: ctx.version };
  const data = overlayForSegment(inst, ctx.pathIndex, ctx.segIndex, ctx.pointIndex, docRef);
  panel.webview.postMessage({ type: 'liveD', pathIndex: ctx.pathIndex, d: spliced.newD });
  panel.webview.postMessage({ type: 'overlay', data });
  const seg = inst.parsed.segments[ctx.segIndex];
  panel.webview.postMessage({ type: 'info', text: infoText(inst, seg, true) });
}

async function onDragEnd(ctx: DragCtx, x: number, y: number): Promise<void> {
  if (!ctx) return;
  const editor = editorForDrag(ctx);
  if (!editor) return;
  const doc = editor.document;
  const spliced = spliceDrag(ctx, x, y, doc.getText());
  if (!spliced || spliced.newD === spliced.baseD) return;

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, rng(doc, ctx.dStart, ctx.dStart + ctx.dLen), spliced.newD);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) return;

  // Keep the cursor on the coordinate we just edited so the highlight/overlay stay on it.
  const pos = doc.positionAt(ctx.dStart + ctx.slotStart);
  editor.selection = new vscode.Selection(pos, pos);
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function getNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function getHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', 'preview.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extCtx.extensionUri, 'media', 'preview.js'));
  // No remote img-src: a previewed SVG must not be able to phone home
  // (external <image href> / CSS url() would be a zero-click tracking beacon).
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${cssUri}" rel="stylesheet">
<title>SVG Preview</title>
</head>
<body>
<div id="toolbar">
  <div class="tb-grp">
    <button id="zoom-out" title="Zoom out">&#8722;</button>
    <span id="zoom-label">100%</span>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-fit" title="Fit to width">Fit</button>
  </div>
  <div class="tb-grp" id="bg-grp">
    <button data-bg="checker" title="Checkerboard">&#9638;</button>
    <button data-bg="light" title="Light background">&#9723;</button>
    <button data-bg="dark" title="Dark background">&#9724;</button>
  </div>
  <button id="grid-toggle" class="tb-toggle" title="Toggle coordinate grid &amp; rulers">Grid</button>
</div>
<div id="frame">
  <div id="corner"></div>
  <svg id="ruler-top" class="ruler" xmlns="http://www.w3.org/2000/svg"></svg>
  <svg id="ruler-left" class="ruler" xmlns="http://www.w3.org/2000/svg"></svg>
  <div id="stage">
    <div id="svg-container"></div>
    <svg id="overlay" xmlns="http://www.w3.org/2000/svg">
      <g id="o-guides"></g>
      <g id="o-content"></g>
      <rect id="o-surface" x="-100000" y="-100000" width="200000" height="200000" fill="transparent"></rect>
    </svg>
    <div id="coord-badge"></div>
  </div>
</div>
<div id="info"></div>
<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Coordinate conversion command
// ---------------------------------------------------------------------------

async function convertSelection(mode: 'abs' | 'rel'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const text = doc.getText();
  const paths = findPaths(text);
  if (!paths.length) {
    vscode.window.showInformationMessage('SVG Path Helper: no <path> elements found.');
    return;
  }

  const precision = cfg('precision', 6);
  const targets = new Set<number>();

  paths.forEach((p, idx) => {
    const dRange = rng(doc, p.dStart, p.dStart + p.dText.length);
    for (const sel of editor.selections) {
      if (sel.isEmpty) {
        if (dRange.contains(sel.active)) targets.add(idx);
      } else if (sel.intersection(dRange)) {
        targets.add(idx);
      }
    }
  });

  if (targets.size === 0) {
    vscode.window.showInformationMessage(
      'SVG Path Helper: place the cursor inside a <path d="..."> or select one first.',
    );
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  for (const idx of targets) {
    const p = paths[idx];
    const newD = convertD(p.dText, mode, precision);
    edit.replace(doc.uri, rng(doc, p.dStart, p.dStart + p.dText.length), newD);
  }
  await vscode.workspace.applyEdit(edit);
}

// ---------------------------------------------------------------------------
// Transform operations (matrix conversion / resolve)
// ---------------------------------------------------------------------------

function updateTransformContext(editor?: vscode.TextEditor): void {
  let on = false;
  const ed = editor ?? vscode.window.activeTextEditor;
  if (ed && isSvgish(ed.document)) {
    const doc = ed.document;
    const sel = ed.selection; // primary selection — matches what runTransformOp acts on
    on = cursorOnTransform(doc.getText(), doc.offsetAt(sel.start), doc.offsetAt(sel.end));
  }
  void vscode.commands.executeCommand('setContext', 'svgPathHelper.cursorOnTransform', on);
}

function scheduleTransformContext(): void {
  if (ctxTimer) clearTimeout(ctxTimer);
  ctxTimer = setTimeout(() => updateTransformContext(), 90);
}

async function runTransformOp(kind: OpKind): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  const sel = editor.selection;
  const edits = buildTransformEdits(
    doc.getText(), doc.offsetAt(sel.start), doc.offsetAt(sel.end), kind, cfg('precision', 6),
  );
  if (!edits || edits.length === 0) {
    vscode.window.showInformationMessage('SVG Path Helper: place the cursor on a transform="…" value first.');
    return;
  }
  const we = new vscode.WorkspaceEdit();
  for (const e of edits) {
    we.replace(doc.uri, new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)), e.text);
  }
  await vscode.workspace.applyEdit(we);
}
