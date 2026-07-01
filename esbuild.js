const esbuild = require('esbuild');

const watch = process.argv.includes('--watch');

const common = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

// Desktop (Node) extension host and the browser/web extension host (vscode.dev,
// github.dev, code-server). The extension uses no Node APIs, so the same source
// bundles cleanly for both.
const node = { ...common, outfile: 'dist/extension.js', format: 'cjs', platform: 'node', target: 'node16' };
const web = { ...common, outfile: 'dist/web/extension.js', format: 'cjs', platform: 'browser', target: 'es2020' };

(async () => {
  if (watch) {
    const ctxs = await Promise.all([esbuild.context(node), esbuild.context(web)]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('[esbuild] watching for changes (node + web)...');
  } else {
    await Promise.all([esbuild.build(node), esbuild.build(web)]);
    console.log('[esbuild] build complete (node + web)');
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
