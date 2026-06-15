// @ts-check
// Webview script.
//
// Renders the user's SVG and draws a cursor-aware overlay (current path,
// current segment, its points, selected point). Overlay geometry arrives in
// the *local* coordinate space of the active <path>; we map it to the SVG root
// space using the rendered element's CTM, so parent <g transform>s, the path's
// own transform, and nested transforms are all honoured natively.
//
// Points are draggable; a drag inverts the path's screen CTM and is committed
// as a single document edit on release.
//
// Rulers (top + left) are calibrated to the root viewBox coordinate space and
// indicate: the bounding box of the whole current path, the current segment's
// next (end) point, and the live mouse position — each with guide lines toward
// the rulers. The mouse coordinates are also shown in a corner badge.

(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';

  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const container = /** @type {HTMLElement} */ (document.getElementById('svg-container'));
  const overlay = /** @type {SVGSVGElement} */ (/** @type {any} */ (document.getElementById('overlay')));
  const content = /** @type {SVGGElement} */ (/** @type {any} */ (document.getElementById('o-content')));
  const guides = /** @type {SVGGElement} */ (/** @type {any} */ (document.getElementById('o-guides')));
  const surface = /** @type {SVGRectElement} */ (/** @type {any} */ (document.getElementById('o-surface')));
  const rulerTop = /** @type {SVGSVGElement} */ (/** @type {any} */ (document.getElementById('ruler-top')));
  const rulerLeft = /** @type {SVGSVGElement} */ (/** @type {any} */ (document.getElementById('ruler-left')));
  const badge = /** @type {HTMLElement} */ (document.getElementById('coord-badge'));
  const info = /** @type {HTMLElement} */ (document.getElementById('info'));

  /** @type {any} */ let lastOverlay = null;
  /** @type {{x:number,y:number}|null} */ let mouseVB = null;

  let drawScheduled = false;
  let rulersScheduled = false;
  let ctmRetries = 0;
  const MAX_CTM_RETRIES = 6;

  // Active drag state.
  /** @type {any} */ let dragging = null;
  let dragPointerId = -1;
  /** @type {PointerEvent|null} */ let pendingEvent = null;
  let moveScheduled = false;

  function svgEl() {
    return container.querySelector('svg');
  }

  function pathElFor(idx) {
    if (idx == null || idx < 0) return null;
    return container.querySelector('[data-sph-idx="' + idx + '"]');
  }

  function node(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, String(attrs[k]));
    if (parent) parent.appendChild(e);
    return e;
  }

  function requestDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => { drawScheduled = false; draw(); });
  }

  function requestRulers() {
    if (rulersScheduled || drawScheduled) return;
    rulersScheduled = true;
    requestAnimationFrame(() => { rulersScheduled = false; drawRulers(); });
  }

  // The overlay is a 1:1 pixel canvas matched to the rendered SVG's on-screen
  // box. getCTM() maps a path's local coords straight to these pixels — it
  // already folds in the SVG's viewBox transform AND every parent/own transform
  // — so we draw with it directly, no viewBox/preserveAspectRatio matching.
  function positionOverlay() {
    const el = svgEl();
    if (!el) { overlay.style.display = 'none'; return; }
    overlay.style.display = '';

    const r = el.getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    overlay.style.left = (r.left - sr.left) + 'px';
    overlay.style.top = (r.top - sr.top) + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.setAttribute('viewBox', '0 0 ' + (r.width || 1) + ' ' + (r.height || 1));
    overlay.removeAttribute('preserveAspectRatio');
  }

  /** Overlay coordinates are already in screen pixels. */
  function px(n) {
    return n;
  }

  function ctmStr(m) {
    return m ? 'matrix(' + m.a + ',' + m.b + ',' + m.c + ',' + m.d + ',' + m.e + ',' + m.f + ')' : '';
  }

  /** Map a local point to root (overlay pixel) space via matrix m (or identity). */
  function toRoot(m, x, y) {
    if (!m) return { x: x, y: y };
    const p = overlay.createSVGPoint();
    p.x = x; p.y = y;
    const q = p.matrixTransform(m);
    return { x: q.x, y: q.y };
  }

  function clearContent() {
    while (content.firstChild) content.removeChild(content.firstChild);
  }

  function makeCircle(cx, cy, r, cls) {
    const c = node('circle', { cx: cx, cy: cy, r: r, class: cls });
    return c;
  }

  function draw() {
    positionOverlay();
    clearContent();
    const d = lastOverlay;

    // local -> root (overlay pixel) matrix of the active path.
    let m = null;
    let retry = false;
    if (d && d.pathIndex >= 0) {
      const el = pathElFor(d.pathIndex);
      if (el && el.getCTM) m = el.getCTM();
      // Element present but CTM not ready (pre-layout): retry the overlay a few
      // frames. The rulers still draw below, so mouse tracking never freezes.
      if (el && !m && ctmRetries < MAX_CTM_RETRIES) { ctmRetries++; requestDraw(); retry = true; }
    }
    if (!retry) ctmRetries = 0;

    if (d && !retry) {
      const g = node('g', m ? { transform: ctmStr(m) } : {});
      if (d.pathD) node('path', { d: d.pathD, class: 'o-path' }, g);
      if (d.segD) node('path', { d: d.segD, class: 'o-seg' }, g);
      content.appendChild(g);

      (d.handles || []).forEach((h) => {
        const a = toRoot(m, h.x1, h.y1);
        const b = toRoot(m, h.x2, h.y2);
        node('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'o-handle' }, content);
      });

      (d.points || []).forEach((pt) => {
        const q = toRoot(m, pt.x, pt.y);
        let r = pt.role === 'control' ? px(3.5) : px(5);
        if (pt.selected) r = px(7);
        if (pt.drag) {
          const hit = makeCircle(q.x, q.y, px(11), 'o-hit');
          hit.addEventListener('pointerdown', (e) => startDrag(e, pt.drag));
          content.appendChild(hit);
        }
        const cls = 'o-pt ' + (pt.role === 'control' ? 'o-ctrl' : 'o-end')
          + (pt.selected ? ' o-sel' : '') + (pt.drag ? ' draggable' : '');
        content.appendChild(makeCircle(q.x, q.y, r, cls));
      });
    }

    drawRulers();
  }

  // --- rulers ---------------------------------------------------------------

  function rootCTM() { const el = svgEl(); return el && el.getCTM ? el.getCTM() : null; }       // viewBox -> overlay px
  function rootScreenCTM() { const el = svgEl(); return el && el.getScreenCTM ? el.getScreenCTM() : null; } // viewBox -> screen px

  function rootViewBox() {
    const el = svgEl();
    const vb = el && el.viewBox && el.viewBox.baseVal;
    if (vb && vb.width && vb.height) return { x: vb.x, y: vb.y, w: vb.width, h: vb.height };
    const r = el ? el.getBoundingClientRect() : { width: 1, height: 1 };
    const w = (el && el.width && el.width.baseVal && el.width.baseVal.value) || r.width || 1;
    const h = (el && el.height && el.height.baseVal && el.height.baseVal.value) || r.height || 1;
    return { x: 0, y: 0, w: w, h: h };
  }

  /** Matrix mapping the active path's local coords -> root viewBox coords, or null. */
  function localToViewBox(idx) {
    const pe = pathElFor(idx);
    const rc = rootCTM();
    if (!pe || !pe.getCTM || !rc) return null;
    const pc = pe.getCTM();
    if (!pc) return null;
    try { return rc.inverse().multiply(pc); } catch (e) { return null; }
  }

  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
    return m * pow;
  }

  function fmtCoord(n) {
    const r = Math.round(n * 10) / 10;
    return String(Object.is(r, -0) ? 0 : r);
  }

  function transformPoint(m, x, y) {
    const p = overlay.createSVGPoint();
    p.x = x; p.y = y;
    return p.matrixTransform(m);
  }

  function drawRulers() {
    const el = svgEl();
    if (!el || !rulerTop || !rulerLeft) return;
    rulerTop.textContent = '';
    rulerLeft.textContent = '';
    guides.textContent = '';

    const ms = rootScreenCTM();
    const mc = rootCTM();
    if (!ms || !mc) { badge.classList.remove('active'); return; }

    const rtR = rulerTop.getBoundingClientRect();
    const rlR = rulerLeft.getBoundingClientRect();
    const tw = rtR.width, th = rtR.height, lw = rlR.width, lh = rlR.height;
    rulerTop.setAttribute('width', String(tw));
    rulerTop.setAttribute('height', String(th));
    rulerLeft.setAttribute('width', String(lw));
    rulerLeft.setAttribute('height', String(lh));

    const vb = rootViewBox();

    // viewBox value -> pixel offset within each ruler / the overlay
    const offX = (vx) => transformPoint(ms, vx, vb.y).x - rtR.left;
    const offY = (vy) => transformPoint(ms, vb.x, vy).y - rlR.top;
    const ovX = (vx) => transformPoint(mc, vx, 0).x;
    const ovY = (vy) => transformPoint(mc, 0, vy).y;
    const ovRect = overlay.getBoundingClientRect();
    const ovH = ovRect.height || 1;
    const ovW = ovRect.width || 1;

    // --- scale ticks ---
    drawScaleX(tw, th, vb, niceStep(64 / (Math.abs(ms.a) || 1)), offX);
    drawScaleY(lw, lh, vb, niceStep(64 / (Math.abs(ms.d) || 1)), offY);

    const ov = lastOverlay;
    if (ov && ov.pathIndex >= 0) {
      const m = localToViewBox(ov.pathIndex);
      const pe = pathElFor(ov.pathIndex);

      // --- path bounding box ---
      if (m && pe && pe.getBBox) {
        try {
          const bb = pe.getBBox();
          const cs = [[bb.x, bb.y], [bb.x + bb.width, bb.y], [bb.x, bb.y + bb.height], [bb.x + bb.width, bb.y + bb.height]]
            .map((c) => transformPoint(m, c[0], c[1]));
          const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
          const bx0 = Math.min.apply(null, xs), bx1 = Math.max.apply(null, xs);
          const by0 = Math.min.apply(null, ys), by1 = Math.max.apply(null, ys);
          // Math.min/abs so the rect stays valid even under a flipped/negative-scale root CTM.
          const gx = Math.min(ovX(bx0), ovX(bx1)), gy = Math.min(ovY(by0), ovY(by1));
          node('rect', { x: gx, y: gy, width: Math.abs(ovX(bx1) - ovX(bx0)), height: Math.abs(ovY(by1) - ovY(by0)), class: 'g-bbox' }, guides);
          bracketX(offX(bx0), offX(bx1), fmtCoord(bx0), fmtCoord(bx1));
          bracketY(offY(by0), offY(by1), fmtCoord(by0), fmtCoord(by1));
        } catch (e) { /* getBBox can throw pre-layout */ }
      }

      // --- segment next (end) point ---
      const ep = (ov.points || []).find((p) => p.role === 'endpoint');
      if (ep && m) {
        const e = transformPoint(m, ep.x, ep.y);
        const oxp = ovX(e.x), oyp = ovY(e.y);
        node('line', { x1: oxp, y1: oyp, x2: oxp, y2: 0, class: 'g-seg' }, guides);
        node('line', { x1: oxp, y1: oyp, x2: 0, y2: oyp, class: 'g-seg' }, guides);
        caretX(th, offX(e.x), fmtCoord(e.x), 'seg');
        caretY(lw, offY(e.y), fmtCoord(e.y), 'seg');
      }
    }

    // --- mouse ---
    if (mouseVB) {
      const oxp = ovX(mouseVB.x), oyp = ovY(mouseVB.y);
      node('line', { x1: oxp, y1: 0, x2: oxp, y2: ovH, class: 'g-mouse' }, guides);
      node('line', { x1: 0, y1: oyp, x2: ovW, y2: oyp, class: 'g-mouse' }, guides);
      caretX(th, offX(mouseVB.x), fmtCoord(mouseVB.x), 'mouse');
      caretY(lw, offY(mouseVB.y), fmtCoord(mouseVB.y), 'mouse');
      badge.textContent = 'x ' + fmtCoord(mouseVB.x) + '   y ' + fmtCoord(mouseVB.y);
      badge.classList.add('active');
    } else {
      badge.classList.remove('active');
    }
  }

  function drawScaleX(w, h, vb, step, offX) {
    const start = Math.ceil(vb.x / step) * step;
    for (let v = start; v <= vb.x + vb.w + 1e-6; v += step) {
      const x = offX(v);
      if (x < -1 || x > w + 1) continue;
      node('line', { x1: x, y1: h * 0.5, x2: x, y2: h, class: 'r-tick-major' }, rulerTop);
      const t = node('text', { x: x + 2, y: h * 0.5, class: 'r-label' }, rulerTop);
      t.textContent = fmtCoord(v);
    }
  }

  function drawScaleY(w, h, vb, step, offY) {
    const start = Math.ceil(vb.y / step) * step;
    for (let v = start; v <= vb.y + vb.h + 1e-6; v += step) {
      const y = offY(v);
      if (y < -1 || y > h + 1) continue;
      node('line', { x1: w * 0.5, y1: y, x2: w, y2: y, class: 'r-tick-major' }, rulerLeft);
      const t = node('text', { x: 3, y: y - 2, class: 'r-label' }, rulerLeft);
      t.textContent = fmtCoord(v);
    }
  }

  function caretX(h, x, label, kind) {
    node('path', { d: 'M' + (x - 4) + ' ' + h + 'L' + (x + 4) + ' ' + h + 'L' + x + ' ' + (h - 6) + 'Z', class: 'r-caret-' + kind }, rulerTop);
    const t = node('text', { x: x + 5, y: 9, class: 'r-caret-label-' + kind }, rulerTop);
    t.textContent = label;
  }

  function caretY(w, y, label, kind) {
    node('path', { d: 'M' + w + ' ' + (y - 4) + 'L' + w + ' ' + (y + 4) + 'L' + (w - 6) + ' ' + y + 'Z', class: 'r-caret-' + kind }, rulerLeft);
    const t = node('text', { x: 2, y: y + 9, class: 'r-caret-label-' + kind }, rulerLeft);
    t.textContent = label;
  }

  function bracketX(x0, x1, l0, l1) {
    const y = 3;
    node('path', { d: 'M' + x0 + ' ' + (y + 4) + 'L' + x0 + ' ' + y + 'L' + x1 + ' ' + y + 'L' + x1 + ' ' + (y + 4), class: 'r-bbox' }, rulerTop);
    const a = node('text', { x: x0 + 2, y: y + 11, class: 'r-bbox-label' }, rulerTop); a.textContent = l0;
    const b = node('text', { x: x1 - 2, y: y + 11, class: 'r-bbox-label', 'text-anchor': 'end' }, rulerTop); b.textContent = l1;
  }

  function bracketY(y0, y1, l0, l1) {
    const x = 3;
    node('path', { d: 'M' + (x + 4) + ' ' + y0 + 'L' + x + ' ' + y0 + 'L' + x + ' ' + y1 + 'L' + (x + 4) + ' ' + y1, class: 'r-bbox' }, rulerLeft);
    const a = node('text', { x: x + 6, y: y0 + 9, class: 'r-bbox-label' }, rulerLeft); a.textContent = l0;
    const b = node('text', { x: x + 6, y: y1 - 3, class: 'r-bbox-label' }, rulerLeft); b.textContent = l1;
  }

  function onStageMove(e) {
    const ms = rootScreenCTM();
    if (!ms) return;
    const q = transformPoint(ms.inverse(), e.clientX, e.clientY);
    mouseVB = { x: q.x, y: q.y };
    requestRulers();
  }

  function onStageLeave() {
    mouseVB = null;
    requestRulers();
  }

  stage.addEventListener('pointermove', onStageMove);
  stage.addEventListener('pointerleave', onStageLeave);

  // --- dragging -------------------------------------------------------------

  /** Convert client (screen) coords to the active path's local coords, or null. */
  function screenToLocal(clientX, clientY) {
    const el = dragging ? pathElFor(dragging.pathIndex) : null;
    const m = el && el.getScreenCTM ? el.getScreenCTM() : null;
    if (!m) return null;
    const q = transformPoint(m.inverse(), clientX, clientY);
    return { x: q.x, y: q.y };
  }

  function startDrag(e, ctx) {
    e.preventDefault();
    e.stopPropagation();
    dragging = ctx;
    dragPointerId = e.pointerId;
    surface.style.pointerEvents = 'all';
    try { surface.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }

  function flushDrag() {
    moveScheduled = false;
    if (!dragging || !pendingEvent) return;
    const loc = screenToLocal(pendingEvent.clientX, pendingEvent.clientY);
    if (!loc) return;
    vscode.postMessage({ type: 'dragMove', ctx: dragging, x: loc.x, y: loc.y });
  }

  surface.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    pendingEvent = e;
    if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(flushDrag); }
  });

  function endDrag(e, commit) {
    if (!dragging || e.pointerId !== dragPointerId) return;
    if (commit) {
      const loc = screenToLocal(e.clientX, e.clientY);
      if (loc) vscode.postMessage({ type: 'dragEnd', ctx: dragging, x: loc.x, y: loc.y });
    }
    try { surface.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    dragging = null;
    dragPointerId = -1;
    pendingEvent = null;
    surface.style.pointerEvents = 'none';
  }

  surface.addEventListener('pointerup', (e) => endDrag(e, true));
  surface.addEventListener('pointercancel', (e) => endDrag(e, false));

  // --- messages -------------------------------------------------------------

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'render') {
      container.innerHTML = m.svg || '';
      const el = svgEl();
      if (el) {
        el.style.display = 'block';
        if (el.getAttribute('viewBox')) {
          el.removeAttribute('width');
          el.removeAttribute('height');
          el.style.width = '100%';
          el.style.height = 'auto';
          el.style.maxHeight = '78vh';
        } else {
          el.style.maxWidth = '100%';
          el.style.maxHeight = '78vh';
        }
      }
      ctmRetries = 0;
      requestDraw();
    } else if (m.type === 'overlay') {
      lastOverlay = m.data;
      ctmRetries = 0;
      requestDraw();
    } else if (m.type === 'liveD') {
      const el = pathElFor(m.pathIndex);
      if (el) el.setAttribute('d', m.d);
    } else if (m.type === 'info') {
      info.textContent = m.text || '';
    }
  });

  window.addEventListener('resize', requestDraw);

  vscode.postMessage({ type: 'ready' });
})();
