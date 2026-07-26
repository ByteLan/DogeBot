import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 编译后本文件位于 dist/main/paths.js，其上一级即 dist 根目录；
// preload 脚本与 index.html 均被构建步骤放置在 dist 根目录，与原 __dirname 相对关系保持一致。
const distRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export const preloadPath = join(distRoot, 'preload.cjs');
export const douyinPreloadPath = join(distRoot, 'douyin-preload.cjs');
export const indexHtmlPath = join(distRoot, 'index.html');
