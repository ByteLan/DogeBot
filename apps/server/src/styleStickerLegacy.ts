/**
 * Legacy sticker renderer using @napi-rs/canvas directly.
 * Activated by setting DOGEBOT_STYLE_STICKER_LEGACY_RENDERER=1.
 */
import { existsSync } from 'node:fs';
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
  type GlyphMeasurement,
  type StickerControls,
  type StickerFlavor
} from './styleStickerCore.js';
import { encodeUltraHdrJpeg } from './utils/ultraHdr.js';

type FontDescriptor = {
  family: string;
  localFile: string;
  fontWeight: string;
  scaleX: number;
  scaleY: number;
  rotationDeg: number;
  skewXDeg: number;
  skewYDeg: number;
};

const BASE_FONT_SIZE = 220;
const MAX_OUTPUT_EDGE = 4096;
const moduleDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(moduleDir);
const appRootDir = appDir.endsWith('/dist') ? dirname(appDir) : appDir;

/**
 * 解析 @syru/byted-sticker-generator 包内 public/ 目录路径。
 * 主字体（DouyinSansBold / YouSheBiaoTiHei）已从 assets/fonts 移到包内，
 * legacy 渲染器需要在这里找到它们。
 */
function resolvePackageFontsDir(): string {
  try {
    const entryUrl = import.meta.resolve('@syru/byted-sticker-generator/node');
    const entryPath = fileURLToPath(entryUrl);
    // entry 在 <pkg>/lib/sticker/node.mjs，向上 3 级到包根
    const pkgDir = dirname(dirname(dirname(entryPath)));
    const publicDir = join(pkgDir, 'public');
    if (existsSync(publicDir)) return publicDir;
  } catch { /* package may not be installed */ }
  return '';
}

const packageFontsDir = resolvePackageFontsDir();

const FONT_DESCRIPTORS: Record<StickerFlavor, FontDescriptor> = {
  snh: {
    family: 'DouyinSansBold',
    localFile: 'DouyinSansBold.woff2',
    fontWeight: 'normal',
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    skewXDeg: 0,
    skewYDeg: -3.5,
  },
  bs: {
    family: 'YouSheBiaoTiHei',
    localFile: 'YouSheBiaoTiHei.ttf',
    fontWeight: 'normal',
    scaleX: 1,
    scaleY: 1.12,
    rotationDeg: 2,
    skewXDeg: 5,
    skewYDeg: -2.1,
  }
};

const fontLoadPromises = new Map<StickerFlavor, Promise<void>>();
let fallbackFontsLoaded = false;

const FALLBACK_FONT_DESCRIPTORS = [
  { family: 'Apple Color Emoji', file: 'AppleColorEmoji.ttf', optional: true },
  { family: 'Apple Symbols', file: 'AppleSymbols.ttf', optional: true },
  { family: 'Noto Color Emoji', file: 'NotoColorEmoji.ttf', optional: false },
  { family: 'Noto Sans Symbols 2', file: 'NotoSansSymbols2-Regular.ttf', optional: false },
] as const;

function resolveFontPath(fileName: string) {
  const candidates = [
    join(appDir, 'assets', 'fonts', fileName),
    join(appRootDir, 'assets', 'fonts', fileName),
    packageFontsDir ? join(packageFontsDir, fileName) : ''
  ];
  const matched = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!matched) {
    throw new Error(`style sticker font is missing: ${fileName}`);
  }
  return matched;
}

function resolveOptionalFontPath(fileName: string) {
  const candidates = [
    join(appDir, 'assets', 'fonts', fileName),
    join(appRootDir, 'assets', 'fonts', fileName),
    packageFontsDir ? join(packageFontsDir, fileName) : ''
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

function fontSpec(flavor: StickerFlavor, fontSize: number) {
  const descriptor = FONT_DESCRIPTORS[flavor];
  return [
    `normal ${descriptor.fontWeight} ${fontSize}px "${descriptor.family}"`,
    '"PingFang SC"',
    '"Apple Color Emoji"',
    '"Apple Symbols"',
    '"Noto Color Emoji"',
    '"Noto Sans Symbols 2"',
    'sans-serif'
  ].join(', ');
}

function ensureFallbackFontsLoaded() {
  if (fallbackFontsLoaded) return;
  fallbackFontsLoaded = true;
  for (const descriptor of FALLBACK_FONT_DESCRIPTORS) {
    if (GlobalFonts.has(descriptor.family)) continue;
    const fontPath = descriptor.optional ? resolveOptionalFontPath(descriptor.file) : resolveFontPath(descriptor.file);
    if (!fontPath) continue;
    const registered = GlobalFonts.registerFromPath(fontPath, descriptor.family);
    if (!registered) {
      console.warn(`[style-sticker-legacy] failed to register fallback font: ${descriptor.family}`);
    }
  }
}

async function ensureFontLoaded(flavor: StickerFlavor) {
  ensureFallbackFontsLoaded();
  if (GlobalFonts.has(SHARED_FONT_REGISTRY[flavor].family)) return;
  const existing = fontLoadPromises.get(flavor);
  if (existing) return existing;

  const descriptor = SHARED_FONT_REGISTRY[flavor];
  const promise = (async () => {
    const registered = GlobalFonts.registerFromPath(resolveFontPath(descriptor.file), descriptor.family);
    if (!registered) {
      throw new Error(`failed to register style sticker font: ${descriptor.family}`);
    }
  })().finally(() => {
    fontLoadPromises.delete(flavor);
  });

  fontLoadPromises.set(flavor, promise);
  return promise;
}

function createGradient(
  context: SKRSContext2D,
  width: number,
  height: number,
  angleDeg: number,
  colors: readonly [string, string],
) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const halfLength = (Math.abs(dx) * width + Math.abs(dy) * height) / 2;
  const centerX = width / 2;
  const centerY = height / 2;
  const gradient = context.createLinearGradient(
    centerX - dx * halfLength,
    centerY - dy * halfLength,
    centerX + dx * halfLength,
    centerY + dy * halfLength
  );
  gradient.addColorStop(0, colors[0]);
  gradient.addColorStop(1, colors[1]);
  return gradient;
}

function cropCanvasAlpha(sourceCanvas: Canvas) {
  const context = sourceCanvas.getContext('2d');
  const imageData = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  let left = sourceCanvas.width;
  let top = sourceCanvas.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < sourceCanvas.height; y += 1) {
    for (let x = 0; x < sourceCanvas.width; x += 1) {
      const alpha = imageData.data[(y * sourceCanvas.width + x) * 4 + 3];
      if (alpha <= 16) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    throw new Error('rendered sticker is empty');
  }

  const width = right - left + 1;
  const height = bottom - top + 1;
  const output: Canvas = createCanvas(width, height);
  output.getContext('2d').drawImage(sourceCanvas, left, top, width, height, 0, 0, width, height);
  return output;
}

function resizeCanvasByScale(sourceCanvas: Canvas, scale: number, maxEdge: number) {
  const scaledWidth = Math.max(1, Math.round(sourceCanvas.width * scale));
  const scaledHeight = Math.max(1, Math.round(sourceCanvas.height * scale));
  const longestEdge = Math.max(scaledWidth, scaledHeight);
  const clampScale = longestEdge > maxEdge ? maxEdge / longestEdge : 1;
  const outputWidth = Math.max(1, Math.round(scaledWidth * clampScale));
  const outputHeight = Math.max(1, Math.round(scaledHeight * clampScale));
  const canvas: Canvas = createCanvas(outputWidth, outputHeight);
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(sourceCanvas, 0, 0, outputWidth, outputHeight);
  return canvas;
}

function padCanvas(sourceCanvas: Canvas, paddingX: number, paddingY: number) {
  const x = Math.max(0, Math.round(paddingX));
  const y = Math.max(0, Math.round(paddingY));
  if (x === 0 && y === 0) return sourceCanvas;
  const width = sourceCanvas.width + x * 2;
  const height = sourceCanvas.height + y * 2;
  const canvas: Canvas = createCanvas(width, height);
  canvas.getContext('2d').drawImage(sourceCanvas, x, y);
  return canvas;
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
    if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[qTail++] = i - 1; }
    if (x < width - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[qTail++] = i + 1; }
    if (y > 0 && dist[i - width] > d) { dist[i - width] = d; queue[qTail++] = i - width; }
    if (y < height - 1 && dist[i + width] > d) { dist[i + width] = d; queue[qTail++] = i + width; }
  }
  let modified = false;
  for (let i = 0; i < total; i++) {
    if (dist[i] <= intRadius && data[i * 4 + 3] > 16) { data[i * 4 + 3] = 0; modified = true; }
  }
  if (modified) ctx.putImageData(imageData, 0, 0);
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
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) { exterior[i] = 1; stack[++stackTop] = i; }
  };
  for (let x = 0; x < width; x += 1) { enqueue(x); enqueue((height - 1) * width + x); }
  for (let y = 1; y < height - 1; y += 1) { enqueue(y * width); enqueue(y * width + width - 1); }
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
  for (let i = 0; i < total; i += 1) {
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) {
      const off = i * 4;
      data[off] = 255; data[off + 1] = 255; data[off + 2] = 255; data[off + 3] = 255;
      filled[i] = 1; modified = true;
    }
  }
  if (modified) {
    stackTop = -1;
    for (let i = 0; i < total; i += 1) { if (filled[i]) stack[++stackTop] = i; }
    const promote = (j: number) => {
      const a = data[j * 4 + 3];
      if (a > 16 && a < 255 && filled[j] === 0) { data[j * 4 + 3] = 255; filled[j] = 1; stack[++stackTop] = j; }
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

function calculateWorkingPadding(controls: StickerControls) {
  return Math.ceil(
    controls.fontSize * 0.15 +
    controls.envelope.outlineStrokeWidth * 2.5 +
    controls.envelope.edgeWidth * 2 +
    Math.abs(controls.alternatingOffset) +
    controls.shadow.blur * 2 +
    Math.max(Math.abs(controls.shadow.offsetX), Math.abs(controls.shadow.offsetY)) +
    4,
  );
}

const glyphMeasureCanvas: Canvas = createCanvas(1, 1);
const glyphMeasureContext = glyphMeasureCanvas.getContext('2d');
const glyphMeasureCache = new Map<string, GlyphMeasurement>();

function measureGlyphWithCanvas(grapheme: string, fontSize: number, flavor: StickerFlavor): GlyphMeasurement {
  const cacheKey = `${flavor}:${fontSize}:${grapheme}`;
  const cached = glyphMeasureCache.get(cacheKey);
  if (cached) return cached;
  glyphMeasureContext.font = fontSpec(flavor, fontSize);
  glyphMeasureContext.textBaseline = 'alphabetic';
  const metrics = glyphMeasureContext.measureText(grapheme);
  const result: GlyphMeasurement = {
    advanceWidth: metrics.width || (metrics.actualBoundingBoxRight || 0) + (metrics.actualBoundingBoxLeft || 0) || fontSize,
    left: metrics.actualBoundingBoxLeft || 0,
    right: metrics.actualBoundingBoxRight || metrics.width,
    ascent: metrics.actualBoundingBoxAscent || fontSize * 0.82,
    descent: metrics.actualBoundingBoxDescent || fontSize * 0.18,
  };
  glyphMeasureCache.set(cacheKey, result);
  return result;
}

function drawPlacedGlyphs(
  context: SKRSContext2D,
  controls: StickerControls,
  layout: ReturnType<typeof createStickerLayout>,
  originX: number,
  originY: number,
  painter: (ctx: SKRSContext2D, grapheme: string) => void,
) {
  const { scale, rotationDeg, skewDeg } = layout.glyphTransform;
  const [scaleX, scaleY] = scale;
  const rotationRad = (rotationDeg * Math.PI) / 180;
  const hSkew = Math.tan((skewDeg[0] * Math.PI) / 180);
  const vSkew = Math.tan((skewDeg[1] * Math.PI) / 180);
  context.font = fontSpec(controls.flavor, controls.fontSize);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  context.miterLimit = 2;
  for (const placement of layout.placements) {
    context.save();
    context.translate(originX + placement.x, originY + placement.baselineY);
    if (placement.skew) {
      if (scaleX !== 1 || scaleY !== 1) context.scale(scaleX, scaleY);
      if (rotationRad !== 0) context.rotate(-rotationRad);
      if (hSkew !== 0) context.transform(1, 0, hSkew, 1, 0, 0);
      if (vSkew !== 0) context.transform(1, vSkew, 0, 1, 0, 0);
    }
    painter(context, placement.grapheme);
    context.restore();
  }
}

async function renderStickerBuffer(
  text: string,
  flavor: StickerFlavor,
  colors: readonly [string, string],
  renderScale: number,
  gradientAngle: number,
) {
  await ensureFontLoaded(flavor);
  const controls = normalizeStickerControls({
    text, flavor,
    fontSize: BASE_FONT_SIZE * renderScale,
    envelope: { colors: [...colors], gradientAngle }
  });
  const baseTransform = sharedFontGlyphTransform(controls.flavor);
  const glyphTransform = controls.tilt
    ? baseTransform
    : { scale: baseTransform.scale, rotationDeg: 0, skewDeg: [0, 0] as [number, number] };
  const layout = createStickerLayout(text, {
    fontSize: controls.fontSize,
    letterSpacing: controls.letterSpacing,
    lineHeight: controls.lineHeight,
    glyphTransform,
    alternatingOffset: controls.peak ? controls.alternatingOffset : 0,
    measureGlyph: (g, fs) => measureGlyphWithCanvas(g, fs, controls.flavor)
  });
  const padding = calculateWorkingPadding(controls);
  const workingWidth = Math.max(1, Math.ceil(layout.bounds.maxX - layout.bounds.minX + padding * 2));
  const workingHeight = Math.max(1, Math.ceil(layout.bounds.maxY - layout.bounds.minY + padding * 2));
  const originX = padding - layout.bounds.minX;
  const originY = padding - layout.bounds.minY;

  const outputCanvas: Canvas = createCanvas(workingWidth, workingHeight);
  const outputContext = outputCanvas.getContext('2d', { alpha: true });
  const gradientStops = resolveGradientStops(controls.envelope.colors);

  const drawStrokeAndFill = (ctx: SKRSContext2D, lw: number, ox = originX, oy = originY) => {
    ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.miterLimit = 2;
    drawPlacedGlyphs(ctx, controls, layout, ox, oy, (c, g) => {
      if (isEmojiGrapheme(g)) return; c.strokeText(g, 0, 0); c.fillText(g, 0, 0);
    });
  };
  const drawFillOnly = (ctx: SKRSContext2D, ox = originX, oy = originY) => {
    drawPlacedGlyphs(ctx, controls, layout, ox, oy, (c, g) => {
      if (isEmojiGrapheme(g)) return; c.fillText(g, 0, 0);
    });
  };

  if (controls.flavor === 'snh') {
    const bandWidth = controls.envelope.outlineStrokeWidth;
    const edgeWidth = controls.envelope.edgeWidth;
    const envelopeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const envelopeCtx = envelopeCanvas.getContext('2d');
    envelopeCtx.fillStyle = '#ffffff'; envelopeCtx.strokeStyle = '#ffffff';
    drawStrokeAndFill(envelopeCtx, bandWidth * 2);
    fillEnclosedRegions(envelopeCanvas);
    envelopeCtx.globalCompositeOperation = 'source-in';
    envelopeCtx.fillStyle = createGradient(envelopeCtx, workingWidth, workingHeight, controls.envelope.gradientAngle, [gradientStops[0], gradientStops[gradientStops.length - 1]]);
    envelopeCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(envelopeCanvas, 0, 0);
    if (edgeWidth > 0 && controls.envelope.edgeOpacity > 0) {
      const edgeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      const edgeCtx = edgeCanvas.getContext('2d');
      edgeCtx.drawImage(envelopeCanvas, 0, 0);
      const erodeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      erodeCanvas.getContext('2d').drawImage(envelopeCanvas, 0, 0);
      erodeCanvasInward(erodeCanvas, edgeWidth);
      edgeCtx.globalCompositeOperation = 'destination-out';
      edgeCtx.drawImage(erodeCanvas, 0, 0);
      edgeCtx.globalCompositeOperation = 'source-in';
      edgeCtx.fillStyle = createGradient(edgeCtx, workingWidth, workingHeight, controls.envelope.gradientAngle, [darken(gradientStops[0], 0.45), darken(gradientStops[gradientStops.length - 1], 0.45)]);
      edgeCtx.fillRect(0, 0, workingWidth, workingHeight);
      outputContext.save(); outputContext.globalAlpha = controls.envelope.edgeOpacity; outputContext.globalCompositeOperation = 'multiply';
      outputContext.drawImage(edgeCanvas, 0, 0); outputContext.restore();
    }
    if (controls.shadow.opacity > 0) {
      const shadowCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      const shadowCtx = shadowCanvas.getContext('2d');
      shadowCtx.fillStyle = '#ffffff'; shadowCtx.strokeStyle = '#ffffff';
      drawStrokeAndFill(shadowCtx, bandWidth * 2);
      fillEnclosedRegions(shadowCanvas);
      shadowCtx.globalCompositeOperation = 'source-atop'; shadowCtx.fillStyle = controls.shadow.color;
      shadowCtx.filter = `blur(${controls.shadow.blur}px)`;
      drawPlacedGlyphs(shadowCtx, controls, layout, originX + controls.shadow.offsetX, originY + controls.shadow.offsetY, (c, g) => { if (!isEmojiGrapheme(g)) c.fillText(g, 0, 0); });
      shadowCtx.filter = 'none';
      outputContext.save(); outputContext.globalAlpha = controls.shadow.opacity; outputContext.globalCompositeOperation = 'multiply';
      outputContext.drawImage(shadowCanvas, 0, 0); outputContext.restore();
    }
    outputContext.fillStyle = '#ffffff'; drawFillOnly(outputContext);
  } else {
    const rimWidth = controls.envelope.outlineStrokeWidth + controls.envelope.edgeWidth;
    const deepCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const deepCtx = deepCanvas.getContext('2d');
    deepCtx.fillStyle = '#ffffff'; deepCtx.strokeStyle = '#ffffff';
    drawStrokeAndFill(deepCtx, rimWidth * 2); fillEnclosedRegions(deepCanvas);
    deepCtx.globalCompositeOperation = 'source-in';
    deepCtx.fillStyle = createGradient(deepCtx, workingWidth, workingHeight, controls.envelope.gradientAngle, [darken(gradientStops[0], 0.42), darken(gradientStops[gradientStops.length - 1], 0.42)]);
    deepCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(deepCanvas, 0, 0);
    const glyphCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const glyphCtx = glyphCanvas.getContext('2d');
    glyphCtx.fillStyle = '#ffffff'; drawFillOnly(glyphCtx);
    glyphCtx.globalCompositeOperation = 'source-in';
    glyphCtx.fillStyle = createGradient(glyphCtx, workingWidth, workingHeight, controls.envelope.gradientAngle, [gradientStops[0], gradientStops[gradientStops.length - 1]]);
    glyphCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(glyphCanvas, 0, 0);
  }

  drawPlacedGlyphs(outputContext, controls, layout, originX, originY, (c, g) => { if (isEmojiGrapheme(g)) c.fillText(g, 0, 0); });

  const croppedCanvas = cropCanvasAlpha(outputCanvas);
  const contentHeight = Math.max(1, layout.bounds.maxY - layout.bounds.minY);
  const exportScale = (BASE_FONT_SIZE * renderScale) / contentHeight;
  const resizedCanvas = resizeCanvasByScale(croppedCanvas, exportScale, Math.round(MAX_OUTPUT_EDGE * renderScale));
  const exportCanvas = padCanvas(resizedCanvas, controls.padding.x, controls.padding.y);
  return exportCanvas.toBuffer('image/png');
}

export interface LegacyRenderResult {
  image: Buffer;
  mime: string;
  extension: string;
}

export async function renderStickerLegacy(
  text: string,
  flavor: StickerFlavor,
  colors: readonly [string, string],
  renderScale: number,
  gradientAngle: number,
  flashStops: number | null,
): Promise<LegacyRenderResult> {
  const pngBuffer = await renderStickerBuffer(text, flavor, colors, renderScale, gradientAngle);
  if (flashStops !== null) {
    const hdrImage = await encodeUltraHdrJpeg(pngBuffer, { flashStops });
    return { image: hdrImage, mime: 'image/jpeg', extension: 'jpg' };
  }
  return { image: pngBuffer, mime: 'image/png', extension: 'png' };
}
