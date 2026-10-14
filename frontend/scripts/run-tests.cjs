const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const babel = require('/usr/share/nodejs/@babel/core');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.test-dist');

function cleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function compileTsDirectory(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const fullSrc = path.join(srcDir, entry.name);
    const fullDest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      compileTsDirectory(fullSrc, fullDest);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      const code = fs.readFileSync(fullSrc, 'utf8');
      const result = babel.transformSync(code, {
        filename: fullSrc,
        presets: [
          ['/usr/share/nodejs/@babel/preset-env', { targets: { node: 'current' }, modules: 'commonjs' }],
          ['/usr/share/nodejs/@babel/preset-typescript'],
        ],
      });
      const outPath = fullDest.replace(/\.ts$/, '.js');
      fs.writeFileSync(outPath, result.code, 'utf8');
    }
  }
}

cleanDir(OUT_DIR);
compileTsDirectory(path.join(ROOT, 'src'), path.join(OUT_DIR, 'src'));
compileTsDirectory(path.join(ROOT, 'tests'), path.join(OUT_DIR, 'tests'));

const testFile = path.join(OUT_DIR, 'tests', 'dashboard.test.js');
const run = spawnSync(process.execPath, ['--test', testFile], {
  stdio: 'inherit',
  cwd: ROOT,
});

fs.rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(run.status ?? 1);
