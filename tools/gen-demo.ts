// Generates standalone demo HTML pages that render exactly what the extension's
// preview webview produces — using the REAL media/preview.css + media/preview.js
// and overlay data computed by the REAL parser — so screenshots are faithful.
//
// Bundled with esbuild and run with node; writes demo/*.html.

import * as fs from 'fs';
import * as path from 'path';
import { parsePath, Segment } from '../src/pathParser';
import { fullAbsoluteD, segmentOverlayD } from '../src/pathConverter';
import { findPaths, extractSvg, tagPaths } from '../src/svgDocument';

const ROOT = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'media', 'preview.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'media', 'preview.js'), 'utf8');
const exampleSvg = fs.readFileSync(path.join(ROOT, 'example.svg'), 'utf8');

const COLORS = {
  command: '#4fc1ff',
  endpoint: '#e8d44d',
  control: '#6a9955',
  segmentBg: 'rgba(120,170,255,0.13)',
  pointBg: 'rgba(255,220,0,0.30)',
  pointBorder: 'rgba(255,220,0,0.85)',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build the highlighted "editor" markup for a `d` string, layering the same
// decorations the extension applies: command / endpoint / control colors,
// current-segment background, selected-point background.
function editorHtml(d: string, segs: Segment[], segIndex: number, selStart: number, selEnd: number): string {
  type Cell = { color: 'cmd' | 'end' | 'ctl' | ''; seg: boolean; sel: boolean };
  const cells: Cell[] = Array.from({ length: d.length }, () => ({ color: '', seg: false, sel: false }));

  segs.forEach((seg, si) => {
    if (seg.explicit && seg.letterStart >= 0) {
      for (let i = seg.letterStart; i < seg.letterEnd; i++) cells[i].color = 'cmd';
    }
    for (const pt of seg.points) {
      if (!pt.hasSource) continue;
      for (let i = pt.start; i < pt.end; i++) cells[i].color = pt.role === 'endpoint' ? 'end' : 'ctl';
    }
    if (si === segIndex) for (let i = seg.start; i < seg.end; i++) cells[i].seg = true;
  });
  for (let i = selStart; i < selEnd; i++) if (cells[i]) cells[i].sel = true;

  let out = '';
  let i = 0;
  while (i < d.length) {
    const c = cells[i];
    let j = i + 1;
    while (j < d.length && cells[j].color === c.color && cells[j].seg === c.seg && cells[j].sel === c.sel) j++;
    const text = esc(d.slice(i, j));
    const styles: string[] = [];
    if (c.color === 'cmd') styles.push(`color:${COLORS.command};font-weight:bold`);
    else if (c.color === 'end') styles.push(`color:${COLORS.endpoint}`);
    else if (c.color === 'ctl') styles.push(`color:${COLORS.control}`);
    if (c.seg) styles.push(`background:${COLORS.segmentBg};border-radius:2px`);
    if (c.sel) styles.push(`background:${COLORS.pointBg};font-weight:bold;border:1px solid ${COLORS.pointBorder};border-radius:2px`);
    out += styles.length ? `<span style="${styles.join(';')}">${text}</span>` : text;
    i = j;
  }
  return out;
}

interface DemoOpts {
  name: string;
  pathOrdinal: number;
  segIndex: number;
  pointIndex: number;
  width: number;
  height: number;
  twoPane: boolean;
  editorPrefix: string; // e.g. '<path d="'
  editorSuffix: string; // e.g. '"/>'
  mouseVx: number;      // synthetic mouse position (viewBox coords) for the screenshot
  mouseVy: number;
}

function buildOverlay(pathOrdinal: number, segs: Segment[], segIndex: number, pointIndex: number) {
  const seg = segs[segIndex];
  const sp = seg.points[pointIndex];
  return {
    pathIndex: pathOrdinal,
    pathD: fullAbsoluteD(segs),
    segD: segmentOverlayD(seg),
    handles: seg.handles.map((h) => ({ x1: h.x1, y1: h.y1, x2: h.x2, y2: h.y2 })),
    points: seg.points.map((pp, idx) => ({ x: pp.x, y: pp.y, role: pp.role, selected: idx === pointIndex, drag: pp.hasSource ? {} : null })),
    selected: sp && sp.hasSource ? { x: sp.x, y: sp.y } : null,
  };
}

const SEG_NAMES: Record<string, string> = {
  M: 'moveto', L: 'lineto', H: 'horizontal lineto', V: 'vertical lineto',
  C: 'cubic Bézier', S: 'smooth cubic', Q: 'quadratic Bézier', T: 'smooth quadratic',
  A: 'elliptical arc', Z: 'closepath',
};

function genDemo(opts: DemoOpts): void {
  const region = extractSvg(exampleSvg)!;
  const tagged = tagPaths(region.svg);
  const regionEnd = region.start + region.svg.length;
  const paths = findPaths(exampleSvg).filter((p) => p.dStart >= region.start && p.dStart < regionEnd);
  const p = paths[opts.pathOrdinal];
  const segs = p.parsed.segments;
  const seg = segs[opts.segIndex];
  const sp = seg.points[opts.pointIndex];

  const overlay = buildOverlay(opts.pathOrdinal, segs, opts.segIndex, opts.pointIndex);
  const info = `${seg.letter}  ·  ${SEG_NAMES[seg.upper]}  ·  ${seg.relative ? 'relative' : 'absolute'}  ·  point selected (drag to edit)`;
  const editor = editorHtml(p.dText, segs, opts.segIndex, sp.start, sp.end);

  const previewPane = `
  <div id="frame">
    <div id="corner"></div>
    <svg id="ruler-top" class="ruler" xmlns="http://www.w3.org/2000/svg"></svg>
    <svg id="ruler-left" class="ruler" xmlns="http://www.w3.org/2000/svg"></svg>
    <div id="stage">
      <div id="svg-container"></div>
      <svg id="overlay" xmlns="http://www.w3.org/2000/svg"><g id="o-guides"></g><g id="o-content"></g><rect id="o-surface" x="-100000" y="-100000" width="200000" height="200000" fill="transparent"></rect></svg>
      <div id="coord-badge"></div>
    </div>
  </div>
  <div id="info"></div>`;

  const editorPane = `
  <div class="editor">
    <div class="ed-line"><span class="ed-tag">${esc(opts.editorPrefix)}</span>${editor}<span class="ed-tag">${esc(opts.editorSuffix)}</span></div>
  </div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root{
  --vscode-foreground:#cccccc; --vscode-font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  --vscode-font-size:13px; --vscode-editor-font-family:"SF Mono",Menlo,Consolas,monospace;
  --vscode-panel-border:#3c3c44;
}
html,body{margin:0;background:#1e1e2e;color:var(--vscode-foreground);font-family:var(--vscode-font-family);}
.wrap{display:flex;gap:0;align-items:stretch;width:${opts.width}px;height:${opts.height}px;box-sizing:border-box;}
.left{flex:0 0 ${opts.twoPane ? '480px' : '0'};display:${opts.twoPane ? 'flex' : 'none'};flex-direction:column;background:#1e1e2e;border-right:1px solid #3c3c44;}
.right{flex:1;padding:14px;display:flex;flex-direction:column;}
.editor{padding:16px 14px;font-family:var(--vscode-editor-font-family);font-size:13px;line-height:1.7;}
.ed-head{color:#6a737d;font-size:11px;margin-bottom:10px;letter-spacing:.04em;text-transform:uppercase;}
.ed-line{white-space:pre-wrap;word-break:break-all;}
.ed-tag{color:#808080;}
.pane-head{color:#6a737d;font-size:11px;margin-bottom:8px;letter-spacing:.04em;text-transform:uppercase;}
${css}
#stage{margin:0;}
#svg-container svg{width:100%;height:auto;}
</style></head>
<body>
<div class="wrap">
  <div class="left">${opts.twoPane ? '<div style="padding:14px 14px 0;" class="ed-head">Editor — &lt;path d&gt; highlighting</div>' : ''}${opts.twoPane ? editorPane : ''}</div>
  <div class="right">
    <div class="pane-head">Preview</div>
    ${previewPane}
  </div>
</div>
<script>window.acquireVsCodeApi=function(){return{postMessage:function(){},getState:function(){},setState:function(){}};};</script>
<script>${js}</script>
<script>
  function send(m){ window.dispatchEvent(new MessageEvent('message',{data:m})); }
  send({type:'render', svg: ${JSON.stringify(tagged)} });
  send({type:'overlay', data: ${JSON.stringify(overlay)} });
  send({type:'info', text: ${JSON.stringify(info)} });
  // Dispatch a synthetic mouse position so the screenshot shows the cursor
  // ruler indicators + coordinate badge.
  function showMouse(){
    var el = document.querySelector('#svg-container svg');
    if(!el || !el.getScreenCTM){ setTimeout(showMouse, 100); return; }
    var p = el.createSVGPoint(); p.x = ${opts.mouseVx}; p.y = ${opts.mouseVy};
    var s = p.matrixTransform(el.getScreenCTM());
    document.getElementById('stage').dispatchEvent(new PointerEvent('pointermove', {clientX:s.x, clientY:s.y, bubbles:true}));
  }
  setTimeout(showMouse, 500);
</script>
</body></html>`;

  const dir = path.join(ROOT, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, opts.name + '.html'), html);
  console.log('wrote demo/' + opts.name + '.html');
}

// Hero: the blue heart/blob path (index 0), C segment, endpoint selected.
genDemo({
  name: 'hero', pathOrdinal: 0, segIndex: 1, pointIndex: 2,
  width: 1000, height: 520, twoPane: true,
  editorPrefix: '<path d="', editorSuffix: '" .../>',
  mouseVx: 118, mouseVy: 58,
});

// Transform: purple square inside a translate/rotate/scale <g> (index 4),
// L segment endpoint selected — proves the overlay follows parent transforms.
genDemo({
  name: 'transform', pathOrdinal: 4, segIndex: 1, pointIndex: 0,
  width: 600, height: 600, twoPane: false,
  editorPrefix: '', editorSuffix: '',
  mouseVx: 60, mouseVy: 120,
});
