// @ts-check
// Webview script.
//
// Renders the user's SVG and draws a cursor-aware overlay (current path,
// current segment, its points, selected point). Overlay geometry arrives in
// the *local* coordinate space of the active <path>; we map it to the SVG root
// space using the rendered element's CTM, so parent <g transform>s, the path's
// own transform, and nested transforms are all honoured natively.
//
// Points are draggable: a drag is computed by inverting the path's screen CTM,
// streamed to the extension for live re-parse + shape preview, and committed as
// a single document edit on release.

(function () {
  const vscode = acquireVsCodeApi();
  const NS = 'http://www.w3.org/2000/svg';

  const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
  const container = /** @type {HTMLElement} */ (document.getElementById('svg-container'));
  const overlay = /** @type {SVGSVGElement} */ (/** @type {any} */ (document.getElementById('overlay')));
  const content = /** @type {SVGGElement} */ (/** @type {any} */ (document.getElementById('o-content')));
  const surface = /** @type {SVGRectElement} */ (/** @type {any} */ (document.getElementById('o-surface')));
  const info = /** @type {HTMLElement} */ (document.getElementById('info'));

  /** @type {any} */ let lastOverlay = null;

  let drawScheduled = false;
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

  function requestDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => { drawScheduled = false; draw(); });
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

  /** Map a local point to root space via matrix m (or identity). */
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
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('class', cls);
    return c;
  }

  function draw() {
    positionOverlay();
    clearContent();
    if (!lastOverlay) return;
    const d = lastOverlay;

    // local -> root (viewBox) matrix of the active path.
    let m = null;
    if (d.pathIndex >= 0) {
      const el = pathElFor(d.pathIndex);
      if (el && el.getCTM) m = el.getCTM();
      // Element present but CTM not ready yet (pre-layout): retry a few frames
      // rather than drawing with an identity transform in the wrong place.
      if (el && !m && ctmRetries < MAX_CTM_RETRIES) { ctmRetries++; requestDraw(); return; }
    }
    ctmRetries = 0;

    // Path outlines: drawn in a group carrying the local->root matrix so the
    // browser transforms the geometry; non-scaling-stroke keeps the line width
    // constant on screen regardless of transform or viewBox scale.
    const g = document.createElementNS(NS, 'g');
    if (m) g.setAttribute('transform', ctmStr(m));
    if (d.pathD) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d.pathD);
      p.setAttribute('class', 'o-path');
      g.appendChild(p);
    }
    if (d.segD) {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d.segD);
      p.setAttribute('class', 'o-seg');
      g.appendChild(p);
    }
    content.appendChild(g);

    // Handles & points: transformed to root space in JS so their pixel sizes
    // stay controllable.
    (d.handles || []).forEach((h) => {
      const a = toRoot(m, h.x1, h.y1);
      const b = toRoot(m, h.x2, h.y2);
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', String(a.x)); l.setAttribute('y1', String(a.y));
      l.setAttribute('x2', String(b.x)); l.setAttribute('y2', String(b.y));
      l.setAttribute('class', 'o-handle');
      content.appendChild(l);
    });

    (d.points || []).forEach((pt) => {
      const q = toRoot(m, pt.x, pt.y);
      let r = pt.role === 'control' ? px(3.5) : px(5);
      if (pt.selected) r = px(7);

      if (pt.drag) {
        // Generous transparent hit target for grabbing.
        const hit = makeCircle(q.x, q.y, px(11), 'o-hit');
        hit.addEventListener('pointerdown', (e) => startDrag(e, pt.drag));
        content.appendChild(hit);
      }

      const cls = 'o-pt ' + (pt.role === 'control' ? 'o-ctrl' : 'o-end')
        + (pt.selected ? ' o-sel' : '') + (pt.drag ? ' draggable' : '');
      content.appendChild(makeCircle(q.x, q.y, r, cls));
    });
  }

  // --- dragging -------------------------------------------------------------

  /** Convert client (screen) coords to the active path's local coords, or null. */
  function screenToLocal(clientX, clientY) {
    const el = dragging ? pathElFor(dragging.pathIndex) : null;
    const m = el && el.getScreenCTM ? el.getScreenCTM() : null;
    if (!m) return null; // only the path's own screen CTM yields the local space
    const p = overlay.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const q = p.matrixTransform(m.inverse());
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
