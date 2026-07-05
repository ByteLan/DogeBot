const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const distDir = path.join(rootDir, 'dist');

fs.mkdirSync(distDir, { recursive: true });

for (const file of ['preload.cjs', 'douyin-preload.cjs']) {
  fs.copyFileSync(path.join(srcDir, file), path.join(distDir, file));
}

const nativeName = 'doge_clipboard_native.node';
const nativeCandidates = [
  path.join(rootDir, 'native', 'clipboard-addon', 'build', 'Release', nativeName),
  path.join(rootDir, 'native', 'clipboard-addon', 'build', 'Debug', nativeName)
];
const nativeSource = nativeCandidates.find((candidate) => fs.existsSync(candidate));

if (nativeSource) {
  const nativeDistDir = path.join(distDir, 'native');
  fs.mkdirSync(nativeDistDir, { recursive: true });
  fs.copyFileSync(nativeSource, path.join(nativeDistDir, nativeName));
  console.log(`[build] copied ${nativeName}`);
} else {
  console.log(`[build] ${nativeName} not found; run pnpm native:build to enable Windows custom MIME restore`);
}
