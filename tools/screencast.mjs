// Screencast capture for the SVG Path Studio extension, running the REAL
// extension inside web VS Code (@vscode/test-web) driven by Playwright.
//
// Pipeline: start web VS Code (browser=none) -> drive it with Playwright while
// recording video -> ffmpeg each clip into a GIF + an APNG.
//
// Usage:
//   node tools/screencast.mjs            # capture all scenes
//   node tools/screencast.mjs --boot-only   # just verify the stack + screenshot
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKSPACE = path.join(__dirname, 'demo-workspace');
const OUT = path.join(__dirname, 'out');
const PORT = 3000;
const VIEW = { width: 1280, height: 800 };
const GIF_WIDTH = 1000;
const FPS = 12;
const BOOT_ONLY = process.argv.includes('--boot-only');
const VERBOSE = process.argv.includes('--verbose');

fs.mkdirSync(OUT, { recursive: true });

// Stream progress to stdout AND a logfile (survives interrupted runs). Each line
// carries wall-clock time and elapsed seconds since start.
const LOG = fs.createWriteStream(path.join(OUT, 'screencast.log'), { flags: 'a' });
const T0 = Date.now();
function log(...a) {
  const wall = new Date().toISOString().slice(11, 19);
  const el = ((Date.now() - T0) / 1000).toFixed(1).padStart(6);
  const line = `[${wall} +${el}s] ${a.join(' ')}`;
  process.stdout.write(line + '\n');
  LOG.write(line + '\n');
}
const human = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB');
const sizeOf = (p) => { try { return human(fs.statSync(p).size); } catch { return '—'; } };

// Attach page instrumentation: console (errors/warnings by default, everything
// with --verbose), uncaught errors, and failed network requests — across the
// main frame and the preview webview iframe.
function instrument(page) {
  page.on('console', (m) => {
    const type = m.type();
    if (VERBOSE || type === 'error' || type === 'warning') log(`    · console.${type}: ${m.text()}`.slice(0, 400));
  });
  page.on('pageerror', (e) => log(`    · pageerror: ${(e.message || String(e)).slice(0, 300)}`));
  page.on('requestfailed', (r) => {
    const url = r.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    log(`    · requestfailed: ${r.method()} ${url.slice(0, 140)} — ${r.failure()?.errorText || '?'}`);
  });
  page.on('framenavigated', (f) => { if (f !== page.mainFrame()) log(`    · webview frame: ${f.url().slice(0, 120)}`); });
}

function startServer() {
  const bin = path.join(ROOT, 'node_modules', '.bin', 'vscode-test-web');
  const args = ['--browser', 'none', `--extensionDevelopmentPath=${ROOT}`, `--port=${PORT}`, WORKSPACE];
  // The VS Code Web download is a one-time network fetch. Node ignores
  // HTTP(S)_PROXY by default (direct DNS), so when a proxy is configured enable
  // Node's built-in env-proxy support for the test-web child. No-op without one.
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
  const env = { ...process.env };
  if (proxy) env.NODE_USE_ENV_PROXY = '1';
  const proc = spawn(bin, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  return new Promise((resolve, reject) => {
    let url = '';
    let downloadNoted = false;
    const onData = (buf) => {
      const s = buf.toString();
      for (const line of s.split('\n')) {
        const t = line.trimEnd();
        if (!t) continue;
        if (/\d+\/\d+\s*\(\d+%\)/.test(t)) continue;        // skip the download progress bar
        if (/Downloading/.test(t)) { if (!downloadNoted) { downloadNoted = true; log('[test-web] downloading VS Code Web (one-time)…'); } continue; }
        log('[test-web] ' + t);
      }
      const m = s.match(/http:\/\/(?:localhost|127\.0\.0\.1):\d+\/?\S*/);
      if (m && !url) { url = m[0]; resolve({ proc, url }); }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', (c) => { if (!url) reject(new Error('test-web exited early, code ' + c)); });
    setTimeout(() => { if (!url) reject(new Error('timed out waiting for server URL')); }, 240000);
  });
}

async function newWorkbench(browser, record) {
  const startedAt = Date.now(); // recording timeline starts at context creation
  const context = await browser.newContext({
    viewport: VIEW,
    recordVideo: record ? { dir: OUT, size: VIEW } : undefined,
  });
  const page = await context.newPage();
  instrument(page);
  log(`  context created (viewport ${VIEW.width}x${VIEW.height}, recordVideo=${!!record})`);
  log('  navigating to', SERVER_URL);
  let ts = Date.now();
  await page.goto(SERVER_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
  log(`  DOMContentLoaded in ${Date.now() - ts}ms; waiting for .monaco-workbench…`);
  ts = Date.now();
  await page.waitForSelector('.monaco-workbench', { timeout: 120000 });
  log(`  workbench rendered in ${Date.now() - ts}ms; settling 5s`);
  await page.waitForTimeout(5000); // activation + layout settle
  const counts = await page.evaluate(() => ({
    editors: document.querySelectorAll('.monaco-editor').length,
    rows: document.querySelectorAll('.monaco-list-row').length,
    webviews: document.querySelectorAll('iframe.webview').length,
  })).catch(() => ({}));
  log(`  DOM: ${counts.editors} editors, ${counts.rows} explorer rows, ${counts.webviews} webviews`);
  return { context, page, startedAt };
}

async function openExample(page) {
  // Double-click the file in the Explorer tree (pins it; single-click is a
  // transient preview tab). Quick Open via Cmd+P is unreliable through the
  // browser, so go through the tree.
  log('  opening example.svg from the Explorer…');
  await page.locator('.monaco-list-row:has-text("example.svg")').first().dblclick({ timeout: 20000 });
  await page.waitForSelector('.view-lines .view-line', { timeout: 30000 });
  await page.waitForTimeout(2500);
  // Diagnostics: what tabs are open and what the editor lines actually contain.
  const tabs = await page.$$eval('.tabs-container .tab', (els) => els.map((e) => (e.textContent || '').trim())).catch(() => []);
  const lines = await page.$$eval('.view-line', (els) => els.map((e) => e.textContent).join(' ¶ ')).catch(() => '');
  log('  tabs:', JSON.stringify(tabs));
  log('  editor text (first 260):', JSON.stringify(lines.slice(0, 260)));
  await page.screenshot({ path: path.join(OUT, 'debug-after-open.png') });
  // Robust readiness signal: "path" has no internal spaces (whitespace-proof).
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('.view-line')).some((el) => (el.textContent || '').includes('path')),
    { timeout: 30000 },
  );
  log('  editor has content; waiting for preview webview…');
  // Preview auto-opens beside; wait for its webview iframe to mount + render.
  const gotWebview = await page.waitForSelector('iframe.webview', { timeout: 30000 }).then(() => true).catch(() => false);
  log('  preview webview:', gotWebview ? 'mounted' : 'NOT found (continuing)');
  await page.waitForTimeout(3500);
}

async function gotoLineCol(page, lineCol) {
  log(`    Ctrl+G -> ${lineCol}`);
  await page.keyboard.press('Control+G');      // Go to Line/Column
  await page.waitForTimeout(450);
  await page.keyboard.type(lineCol);
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(700);
  const pos = await page.getByText(/Ln \d+, Col \d+/).first().textContent().catch(() => null);
  log(`    cursor now at: ${pos ? pos.trim() : '(status unread)'}`);
}

function ffmpeg(args) { execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' }); }

function probe(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'format=duration:stream=width,height,nb_frames', '-of', 'default=nw=1', file], { encoding: 'utf8' });
    return out.trim().split('\n').map((l) => l.trim()).join(', ');
  } catch { return '?'; }
}

function convert(webm, base, trimSec = 0) {
  const vf = `fps=${FPS},scale=${GIF_WIDTH}:-1:flags=lanczos`;
  const palette = path.join(OUT, 'palette.png');
  const ss = trimSec > 0.3 ? ['-ss', trimSec.toFixed(2)] : []; // drop the loading lead-in
  log(`  ffmpeg filter: ${vf}${ss.length ? `  (trim ${trimSec.toFixed(1)}s lead-in)` : ''}`);
  log('  ffmpeg: palettegen…');
  ffmpeg([...ss, '-i', webm, '-vf', `${vf},palettegen=stats_mode=diff`, palette]);
  log('  ffmpeg: gif (paletteuse)…');
  ffmpeg([...ss, '-i', webm, '-i', palette, '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`, `${base}.gif`]);
  log(`    gif: ${sizeOf(base + '.gif')} (${probe(base + '.gif')})`);
  log('  ffmpeg: apng…');
  ffmpeg([...ss, '-i', webm, '-vf', vf, '-plays', '0', '-f', 'apng', `${base}.apng`]);
  log(`    apng: ${sizeOf(base + '.apng')}`);
  fs.rmSync(palette, { force: true });
  log(`  -> wrote ${path.basename(base)}.gif (${sizeOf(base + '.gif')}) + .apng (${sizeOf(base + '.apng')})`);
}

// A scene = { name, setup(page), action(page) }. `setup` opens/positions (the
// lead-in, trimmed out); `action` is the part the GIF should show. A failing
// scene is logged + screenshotted and skipped — the rest still produce output.
async function captureScene(browser, scene) {
  log(`=== scene "${scene.name}" ===`);
  const { context, page, startedAt } = await newWorkbench(browser, true);
  const video = page.video();
  let ok = false, trimSec = 0;
  try {
    await scene.setup(page);
    trimSec = Math.max(0, (Date.now() - startedAt) / 1000 - 0.8); // keep 0.8s pre-roll
    log(`  setup done; action starts ~${trimSec.toFixed(1)}s into the clip`);
    const t = Date.now();
    await scene.action(page);
    await page.waitForTimeout(700);
    log(`  action took ${((Date.now() - t) / 1000).toFixed(1)}s`);
    ok = true;
  } catch (e) {
    log(`  scene "${scene.name}" FAILED: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(OUT, `fail-${scene.name}.png`) }).catch(() => {});
  } finally {
    await context.close(); // finalizes the webm
  }
  const webm = await video.path();
  if (ok) {
    log(`  recorded ${sizeOf(webm)} (${probe(webm)})`);
    convert(webm, path.join(OUT, scene.name), trimSec);
  } else {
    log(`  scene "${scene.name}" skipped (see fail-${scene.name}.png)`);
  }
  fs.rmSync(webm, { force: true });
  return ok;
}

// Sweep the cursor rightward through a path's `d` so decorations + the preview
// overlay track it segment by segment.
async function sweep(page, n) {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(130);
    if (VERBOSE) {
      const pos = await page.getByText(/Ln \d+, Col \d+/).first().textContent().catch(() => null);
      log(`      arrow ${i + 1}/${n}  ${pos ? pos.trim() : ''}`);
    } else if (i % 13 === 12) log(`    sweep ${i + 1}/${n}`);
  }
}

// The preview content lives in a nested webview iframe; drive its toolbar there.
function previewFrame(page) {
  return page.frameLocator('iframe.webview').frameLocator('#active-frame');
}
async function toolbar(page) {
  const f = previewFrame(page);
  const click = async (sel, label, wait = 800) => { log(`    toolbar: ${label}`); await f.locator(sel).click({ timeout: 8000 }); await page.waitForTimeout(wait); };
  await click('#zoom-out', 'zoom −'); await click('#zoom-out', 'zoom −');
  await click('#zoom-in', 'zoom +'); await click('#zoom-fit', 'fit', 1000);
  await click('#bg-grp button[data-bg="light"]', 'background light', 1000);
  await click('#bg-grp button[data-bg="dark"]', 'background dark', 1000);
  await click('#bg-grp button[data-bg="checker"]', 'background checker', 1000);
  await click('#grid-toggle', 'grid off', 1000);
  await click('#grid-toggle', 'grid on', 1000);
}

// Drag a control point of the current segment in the preview. Each `.o-hit`
// circle (r≈11) is a draggable handle; a real mouse drag streams dragMove (live
// curve deform) and commits the new coordinate into the `d` text on release.
async function dragPoint(page) {
  const sel = '.o-hit';
  await previewFrame(page).locator(sel).first().waitFor({ state: 'attached', timeout: 8000 });
  log(`    ${await previewFrame(page).locator(sel).count()} draggable handle(s) on the segment`);
  const doDrag = async (dx, dy, label) => {
    const box = await previewFrame(page).locator(sel).first().boundingBox(); // page coords (nested iframe offset included)
    if (!box) throw new Error('no .o-hit boundingBox');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    log(`    ${label}: from (${x.toFixed(0)},${y.toFixed(0)}) by (${dx},${dy})`);
    await page.mouse.move(x, y); await page.waitForTimeout(250);
    await page.mouse.down(); await page.waitForTimeout(180);
    const steps = 24;
    for (let i = 1; i <= steps; i++) { await page.mouse.move(x + dx * i / steps, y + dy * i / steps); await page.waitForTimeout(24); }
    await page.waitForTimeout(250);
    await page.mouse.up(); await page.waitForTimeout(650);
  };
  await doDrag(80, -55, 'drag out');
  await doDrag(-80, 55, 'drag back');
}

const SCENES = [
  { // core feature: cursor-aware highlighting + overlay on the hero cubic/smooth path
    name: 'cursor-sweep',
    setup: async (p) => { await openExample(p); await gotoLineCol(p, '3:13'); await p.waitForTimeout(500); },
    action: async (p) => { await sweep(p, 48); },
  },
  { // overlay tracks geometry through a parent <g transform> (line 9)
    name: 'transform-follow',
    setup: async (p) => { await openExample(p); await gotoLineCol(p, '9:14'); await p.waitForTimeout(500); },
    action: async (p) => { await sweep(p, 34); },
  },
  { // drag a control point of the cubic in the preview -> the d text updates
    name: 'drag-point',
    setup: async (p) => { await openExample(p); await gotoLineCol(p, '3:25'); await p.waitForTimeout(1200); },
    action: async (p) => { await dragPoint(p); },
  },
  { // preview toolbar: zoom / background / grid
    name: 'toolbar',
    setup: async (p) => { await openExample(p); await gotoLineCol(p, '3:20'); await p.waitForTimeout(800); },
    action: async (p) => { await toolbar(p); },
  },
];

let SERVER_URL = '';
let server;
try {
  log('starting web VS Code server (first run downloads VS Code web)…');
  server = await startServer();
  SERVER_URL = server.url;
  log('server ready at', SERVER_URL);

  log('launching Playwright Chromium…');
  const browser = await chromium.launch();
  log('Chromium launched');

  if (BOOT_ONLY) {
    const { context, page } = await newWorkbench(browser, false);
    await page.screenshot({ path: path.join(OUT, 'boot.png') });
    log('wrote tools/out/boot.png');
    await context.close();
  } else {
    const only = (process.argv.find((a) => a.startsWith('--scene=')) || '').split('=')[1];
    const scenes = only ? SCENES.filter((s) => s.name === only) : SCENES;
    log(`capturing ${scenes.length} scene(s): ${scenes.map((s) => s.name).join(', ')}`);
    const results = [];
    for (const scene of scenes) results.push([scene.name, await captureScene(browser, scene)]);
    log('SUMMARY: ' + results.map(([n, ok]) => `${n}=${ok ? 'OK' : 'FAIL'}`).join('  '));
  }

  await browser.close();
  log('done.');
} catch (e) {
  log('FAILED:', e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server?.proc) server.proc.kill('SIGTERM');
  LOG.end();
}
