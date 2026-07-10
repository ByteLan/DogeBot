/**
 * Debug script: renders "勇攀高峰" in snh flavor step-by-step,
 * outputting each layer as a separate PNG file.
 *
 * Run: npx tsx apps/server/src/debug-sticker-layers.ts
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Canvas, type SKRSContext2D, GlobalFonts, createCanvas } from '@napi-rs/canvas';
import {
  STICKER_FONT_REGISTRY as SHARED_FONT_REGISTRY,
  createStickerLayout,
  darken,
  fontGlyphTransform as sharedFontGlyphTransform,
  isEmojiGrapheme,
  normalizeStickerControls,
  resolveGradientStops,
  type StickerControls,
  type StickerFlavor
} from './styleStickerCore.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(moduleDir);
const appRootDir = appDir.endsWith('/dist') ? dirname(appDir) : appDir;
const BASE_FONT_SIZE = 220;
const outDir = join(appRootDir, 'debug-layers');
mkdirSync(outDir, { recursive: true });

function resolveFontPath(fileName: string) {
  const candidates = [
    join(appDir, 'assets', 'fonts', fileName),
    join(appRootDir, 'assets', 'fonts', fileName)
  ];
  return candidates.find((c) => existsSync(c)) || '';
}

// Register fonts
const FONT_DESCRIPTORS: Record<StickerFlavor, { family: string; file: string }> = {
  snh: { family: 'DouyinSansBold', file: 'DouyinSansBold.woff2' },
  bs: { family: 'YouSheBiaoTiHei', file: 'YouSheBiaoTiHei.ttf' },
};
for (const [, desc] of Object.entries(FONT_DESCRIPTORS)) {
  if (!GlobalFonts.has(desc.family)) {
    const p = resolveFontPath(desc.file);
    if (p) GlobalFonts.registerFromPath(p, desc.family);
  }
}
for (const f of ['NotoColorEmoji.ttf', 'NotoSansSymbols2-Regular.ttf']) {
  const p = resolveFontPath(f);
  if (p) GlobalFonts.registerFromPath(p, f.replace(/\..+$/, ''));
}

function fontSpec(flavor: StickerFlavor, fontSize: number) {
  const descriptor = FONT_DESCRIPTORS[flavor];
  return [
    `normal normal ${fontSize}px "${descriptor.family}"`,
    '"PingFang SC"',
    '"Noto Color Emoji"',
    '"Noto Sans Symbols 2"',
    'sans-serif'
  ].join(', ');
}

function createGradient(
  context: SKRSContext2D, width: number, height: number,
  angleDeg: number, colors: readonly [string, string],
) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const halfLength = (Math.abs(dx) * width + Math.abs(dy) * height) / 2;
  const cx = width / 2, cy = height / 2;
  const gradient = context.createLinearGradient(
    cx - dx * halfLength, cy - dy * halfLength,
    cx + dx * halfLength, cy + dy * halfLength
  );
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  return gradient;
}

function fillEnclosedRegions(canvas: Canvas): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const total = width * height;
  const exterior = new Uint8Array(total);
  const stack = new Int32Array(total);
  let stackTop = -1;
  const enqueue = (i: number) => {
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) {
      exterior[i] = 1;
      stack[++stackTop] = i;
    }
  };
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1); }
  while (stackTop >= 0) {
    const i = stack[stackTop--];
    const x = i % width, y = (i - x) / width;
    if (x > 0) enqueue(i - 1);
    if (x < width - 1) enqueue(i + 1);
    if (y > 0) enqueue(i - width);
    if (y < height - 1) enqueue(i + width);
  }
  let modified = false;
  const filled = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) {
      const off = i * 4;
      data[off] = 255; data[off + 1] = 255; data[off + 2] = 255; data[off + 3] = 255;
      filled[i] = 1;
      modified = true;
    }
  }
  if (modified) {
    stackTop = -1;
    for (let i = 0; i < total; i++) { if (filled[i]) stack[++stackTop] = i; }
    const promote = (j: number) => {
      const a = data[j * 4 + 3];
      if (a > 16 && a < 255 && filled[j] === 0) {
        data[j * 4 + 3] = 255;
        filled[j] = 1;
        stack[++stackTop] = j;
      }
    };
    while (stackTop >= 0) {
      const i = stack[stackTop--];
      const x = i % width, y = (i - x) / width;
      if (x > 0) promote(i - 1);
      if (x < width - 1) promote(i + 1);
      if (y > 0) promote(i - width);
      if (y < height - 1) promote(i + width);
    }
    ctx.putImageData(imageData, 0, 0);
  }
}

function erodeCanvasInward(canvas: Canvas, radius: number): void {
  if (radius <= 0) return;
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const total = width * height;
  const dist = new Uint16Array(total);
  dist.fill(65535);
  const queue = new Int32Array(total);
  let qHead = 0, qTail = 0;
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] <= 16) { dist[i] = 0; queue[qTail++] = i; }
  }
  const intRadius = Math.ceil(radius);
  while (qHead < qTail) {
    const i = queue[qHead++];
    const d = dist[i] + 1;
    if (d > intRadius) continue;
    const x = i % width, y = (i - x) / width;
    if (x > 0 && dist[i-1] > d) { dist[i-1] = d; queue[qTail++] = i-1; }
    if (x < width-1 && dist[i+1] > d) { dist[i+1] = d; queue[qTail++] = i+1; }
    if (y > 0 && dist[i-width] > d) { dist[i-width] = d; queue[qTail++] = i-width; }
    if (y < height-1 && dist[i+width] > d) { dist[i+width] = d; queue[qTail++] = i+width; }
  }
  let modified = false;
  for (let i = 0; i < total; i++) {
    if (dist[i] <= intRadius && data[i * 4 + 3] > 16) { data[i*4+3] = 0; modified = true; }
  }
  if (modified) ctx.putImageData(imageData, 0, 0);
}

function save(canvas: Canvas, name: string) {
  const buf = canvas.toBuffer('image/png');
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, buf);
  console.log(`  → ${path} (${canvas.width}x${canvas.height})`);
}

// ===== Main =====
const text = '勇攀高峰，我可以找你的+1';
const flavor: StickerFlavor = 'snh';
const colors = ['#0989b2', '#73e8d7'] as const;
const gradientAngle = 135;
const renderScale = 1;

const controls = normalizeStickerControls({
  text, flavor,
  fontSize: BASE_FONT_SIZE * renderScale,
  envelope: { colors: [...colors], gradientAngle }
});

const baseTransform = sharedFontGlyphTransform(flavor);
const glyphTransform = controls.tilt
  ? baseTransform
  : { scale: baseTransform.scale, rotationDeg: 0, skewDeg: [0, 0] as [number, number] };

const layout = createStickerLayout(text, {
  fontSize: controls.fontSize,
  letterSpacing: controls.letterSpacing,
  lineHeight: controls.lineHeight,
  glyphTransform,
  alternatingOffset: controls.peak ? controls.alternatingOffset : 0,
  measureGlyph: (grapheme, fontSize) => {
    const c = createCanvas(1, 1);
    const ctx = c.getContext('2d');
    ctx.font = fontSpec(flavor, fontSize);
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(grapheme);
    return {
      advanceWidth: m.width || fontSize,
      left: m.actualBoundingBoxLeft || 0,
      right: m.actualBoundingBoxRight || m.width,
      ascent: m.actualBoundingBoxAscent || fontSize * 0.82,
      descent: m.actualBoundingBoxDescent || fontSize * 0.18,
    };
  }
});

const padding = Math.ceil(
  controls.fontSize * 0.15 +
  controls.envelope.outlineStrokeWidth * 2.5 +
  controls.envelope.edgeWidth * 2 +
  Math.abs(controls.alternatingOffset) +
  controls.shadow.blur * 2 +
  Math.max(Math.abs(controls.shadow.offsetX), Math.abs(controls.shadow.offsetY)) + 4
);
const workingWidth = Math.max(1, Math.ceil(layout.bounds.maxX - layout.bounds.minX + padding * 2));
const workingHeight = Math.max(1, Math.ceil(layout.bounds.maxY - layout.bounds.minY + padding * 2));
const originX = padding - layout.bounds.minX;
const originY = padding - layout.bounds.minY;

console.log(`Working canvas: ${workingWidth}x${workingHeight}`);
console.log(`bandWidth=${controls.envelope.outlineStrokeWidth}, edgeWidth=${controls.envelope.edgeWidth}`);

function drawPlacedGlyphs(
  context: SKRSContext2D,
  painter: (ctx: SKRSContext2D, grapheme: string) => void,
  ox = originX, oy = originY,
) {
  const { scale, rotationDeg, skewDeg } = layout.glyphTransform;
  const [scaleX, scaleY] = scale;
  const rotRad = (rotationDeg * Math.PI) / 180;
  const hSkew = Math.tan((skewDeg[0] * Math.PI) / 180);
  const vSkew = Math.tan((skewDeg[1] * Math.PI) / 180);
  context.font = fontSpec(controls.flavor, controls.fontSize);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  context.miterLimit = 2;
  for (const p of layout.placements) {
    context.save();
    context.translate(ox + p.x, oy + p.baselineY);
    if (p.skew) {
      if (scaleX !== 1 || scaleY !== 1) context.scale(scaleX, scaleY);
      if (rotRad !== 0) context.rotate(-rotRad);
      if (hSkew !== 0) context.transform(1, 0, hSkew, 1, 0, 0);
      if (vSkew !== 0) context.transform(1, vSkew, 0, 1, 0, 0);
    }
    painter(context, p.grapheme);
    context.restore();
  }
}

const drawStrokeAndFill = (ctx: SKRSContext2D, lw: number, ox = originX, oy = originY) => {
  ctx.lineWidth = lw;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.miterLimit = 2;
  drawPlacedGlyphs(ctx, (c, g) => {
    if (isEmojiGrapheme(g)) return;
    c.strokeText(g, 0, 0);
    c.fillText(g, 0, 0);
  }, ox, oy);
};

const bandWidth = controls.envelope.outlineStrokeWidth;
const edgeWidth = controls.envelope.edgeWidth;
const gradientStops = resolveGradientStops(controls.envelope.colors);

console.log('\n=== Step 1: Envelope shape (white, before fillEnclosedRegions) ===');
const step1Canvas: Canvas = createCanvas(workingWidth, workingHeight);
const step1Ctx = step1Canvas.getContext('2d');
step1Ctx.fillStyle = '#ffffff';
step1Ctx.strokeStyle = '#ffffff';
drawStrokeAndFill(step1Ctx, bandWidth * 2);
save(step1Canvas, '01-envelope-before-fill');

console.log('\n=== Step 2: Envelope shape (after fillEnclosedRegions) ===');
fillEnclosedRegions(step1Canvas);
save(step1Canvas, '02-envelope-after-fill');

console.log('\n=== Step 3: Envelope colored with gradient (source-in) ===');
const step3Canvas: Canvas = createCanvas(workingWidth, workingHeight);
const step3Ctx = step3Canvas.getContext('2d');
step3Ctx.drawImage(step1Canvas, 0, 0);
step3Ctx.globalCompositeOperation = 'source-in';
step3Ctx.fillStyle = createGradient(step3Ctx, workingWidth, workingHeight, gradientAngle, [gradientStops[0], gradientStops[gradientStops.length - 1]]);
step3Ctx.fillRect(0, 0, workingWidth, workingHeight);
save(step3Canvas, '03-envelope-gradient');

console.log('\n=== Step 4: Edge ring (envelope - eroded envelope) ===');
const step4Canvas: Canvas = createCanvas(workingWidth, workingHeight);
const step4Ctx = step4Canvas.getContext('2d');
// Copy envelope (already filled with enclosed regions from step 2)
step4Ctx.drawImage(step1Canvas, 0, 0);
// Create eroded version of envelope
const erodeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
const erodeCtxDbg = erodeCanvas.getContext('2d');
erodeCtxDbg.drawImage(step1Canvas, 0, 0);
erodeCanvasInward(erodeCanvas, edgeWidth);
save(erodeCanvas, '04a-eroded-envelope');
// Subtract eroded from envelope -> edge ring
step4Ctx.globalCompositeOperation = 'destination-out';
step4Ctx.drawImage(erodeCanvas, 0, 0);
save(step4Canvas, '04-edge-ring-mask');

console.log('\n=== Step 5: Edge ring colored ===');
step4Ctx.globalCompositeOperation = 'source-in';
step4Ctx.fillStyle = createGradient(step4Ctx, workingWidth, workingHeight, gradientAngle, [darken(gradientStops[0], 0.45), darken(gradientStops[gradientStops.length - 1], 0.45)]);
step4Ctx.fillRect(0, 0, workingWidth, workingHeight);
save(step4Canvas, '05-edge-ring-colored');

console.log('\n=== Step 6: Output after Layer 1 + Layer 2 ===');
const outputCanvas: Canvas = createCanvas(workingWidth, workingHeight);
const outputCtx = outputCanvas.getContext('2d');
outputCtx.drawImage(step3Canvas, 0, 0);
outputCtx.save();
outputCtx.globalAlpha = controls.envelope.edgeOpacity;
outputCtx.globalCompositeOperation = 'multiply';
outputCtx.drawImage(step4Canvas, 0, 0);
outputCtx.restore();
save(outputCanvas, '06-after-layer1-layer2');

console.log('\n=== Step 7: Shadow canvas (envelope shape white) ===');
const shadowCanvas: Canvas = createCanvas(workingWidth, workingHeight);
const shadowCtx = shadowCanvas.getContext('2d');
shadowCtx.fillStyle = '#ffffff';
shadowCtx.strokeStyle = '#ffffff';
drawStrokeAndFill(shadowCtx, bandWidth * 2);
fillEnclosedRegions(shadowCanvas);
save(shadowCanvas, '07-shadow-envelope-white');

console.log('\n=== Step 8: Shadow canvas after source-atop blur ===');
shadowCtx.globalCompositeOperation = 'source-atop';
shadowCtx.fillStyle = controls.shadow.color;
shadowCtx.filter = `blur(${controls.shadow.blur}px)`;
drawPlacedGlyphs(shadowCtx, (c, g) => {
  if (isEmojiGrapheme(g)) return;
  c.fillText(g, 0, 0);
}, originX + controls.shadow.offsetX, originY + controls.shadow.offsetY);
shadowCtx.filter = 'none';
save(shadowCanvas, '08-shadow-after-atop');

console.log('\n=== Step 9: Output after shadow (multiply) ===');
outputCtx.save();
outputCtx.globalAlpha = controls.shadow.opacity;
outputCtx.globalCompositeOperation = 'multiply';
outputCtx.drawImage(shadowCanvas, 0, 0);
outputCtx.restore();
save(outputCanvas, '09-after-shadow');

console.log('\n=== Step 10: Output after white glyph fill ===');
outputCtx.fillStyle = '#ffffff';
drawPlacedGlyphs(outputCtx, (c, g) => {
  if (isEmojiGrapheme(g)) return;
  c.fillText(g, 0, 0);
});
save(outputCanvas, '10-final');

console.log('\nDone! Check:', outDir);
