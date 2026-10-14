const fs = require('node:fs');
const path = require('node:path');
const babel = require('/usr/share/nodejs/@babel/core');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

fs.rmSync(DIST_DIR, { recursive: true, force: true });
fs.mkdirSync(DIST_DIR, { recursive: true });

// Order of modules for clean self-contained bundle
const MODULE_ORDER = [
  'src/types/api.ts',
  'src/config/env.ts',
  'src/services/tokenStore.ts',
  'src/services/apiClient.ts',
  'src/services/wsClient.ts',
  'src/state/dashboardStore.ts',
  'src/ui/app.ts',
  'src/main.ts',
];

const cssContent = fs.readFileSync(path.join(ROOT, 'src/styles/nocturne.css'), 'utf8');

const compiledModules = {};

for (const relPath of MODULE_ORDER) {
  const absPath = path.join(ROOT, relPath);
  let rawCode = fs.readFileSync(absPath, 'utf8');
  // Strip CSS import in main.ts since CSS is injected directly
  rawCode = rawCode.replace(/import\s+['"]\.\/styles\/nocturne\.css['"];?/g, '');

  const transformed = babel.transformSync(rawCode, {
    filename: absPath,
    presets: [
      ['/usr/share/nodejs/@babel/preset-env', { targets: { browsers: ['last 2 versions'] }, modules: 'commonjs' }],
      ['/usr/share/nodejs/@babel/preset-typescript'],
    ],
  });

  const moduleId = relPath.replace(/^src\//, '').replace(/\.ts$/, '');
  compiledModules[moduleId] = transformed.code;
}

const bundleJs = `(function() {
  const modules = {};
  const cache = {};

  function resolvePath(fromId, request) {
    if (!request.startsWith('.')) return request;
    const fromParts = fromId.split('/').slice(0, -1);
    const reqParts = request.split('/');
    for (const part of reqParts) {
      if (part === '.' || part === '') continue;
      if (part === '..') fromParts.pop();
      else fromParts.push(part);
    }
    return fromParts.join('/').replace(/\\.ts$/, '');
  }

  function requireModule(fromId, request) {
    const targetId = resolvePath(fromId, request);
    if (cache[targetId]) return cache[targetId].exports;
    const fn = modules[targetId];
    if (!fn) throw new Error('Cannot find module: ' + targetId + ' (from ' + fromId + ')');
    const mod = { exports: {} };
    cache[targetId] = mod;
    fn(mod, mod.exports, function(req) { return requireModule(targetId, req); });
    return mod.exports;
  }

${ Object.entries(compiledModules)
  .map(
    ([id, code]) => `  modules[${JSON.stringify(id)}] = function(module, exports, require) {\n${code}\n  };`
  )
  .join('\n\n')}

  requireModule('main', './main');
})();`;

fs.writeFileSync(path.join(DIST_DIR, 'app.js'), bundleJs, 'utf8');
fs.writeFileSync(path.join(DIST_DIR, 'styles.css'), cssContent, 'utf8');

const distHtml = `<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nocturne · Smart Home Telemetry &amp; Control Dashboard</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script src="./app.js"></script>
  </body>
</html>`;

fs.writeFileSync(path.join(DIST_DIR, 'index.html'), distHtml, 'utf8');

// Also output standalone single-file HTML for instant preview
const standaloneHtml = `<!DOCTYPE html>
<html lang="vi">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nocturne · Smart Home Telemetry &amp; Control Dashboard</title>
    <style>
${cssContent}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script>
${bundleJs}
    </script>
  </body>
</html>`;

const deliverableDir = path.resolve(ROOT, '../artifacts/file_generation/ttl=63d/output');
fs.mkdirSync(deliverableDir, { recursive: true });
fs.writeFileSync(path.join(deliverableDir, 'smart_home_dashboard.html'), standaloneHtml, 'utf8');

console.log('Build succeeded: dist/index.html and smart_home_dashboard.html generated.');
