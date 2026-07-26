import { copyFileSync } from 'node:fs';

// preload 脚本为 CommonJS，无需经过 tsc/vite；构建后原样复制到 dist 根目录，
// 与主进程 paths.ts 中对 preload 路径的解析保持一致。
for (const file of ['preload.cjs', 'douyin-preload.cjs']) {
  copyFileSync(`src/preload/${file}`, `dist/${file}`);
}
