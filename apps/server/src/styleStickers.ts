import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Canvas, type SKRSContext2D, GlobalFonts, createCanvas } from '@napi-rs/canvas';
import type { Request, Response } from 'express';
import { createConcurrencyLimiter } from './utils/concurrency.js';
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

export type { StickerFlavor } from './styleStickerCore.js';

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
const STYLE_STICKER_RENDER_CONCURRENCY = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_CONCURRENCY, 2);
const STYLE_STICKER_RENDER_QUEUE_MAX = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_QUEUE_MAX, 20);
const STYLE_STICKER_RENDER_TIMEOUT_MS = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_TIMEOUT_MS, 20_000);
const runStyleStickerRenderTask = createConcurrencyLimiter({
  name: 'style-sticker-render',
  limit: STYLE_STICKER_RENDER_CONCURRENCY,
  maxQueue: STYLE_STICKER_RENDER_QUEUE_MAX,
  taskTimeoutMs: STYLE_STICKER_RENDER_TIMEOUT_MS
});
const HIGH_CONTRAST_COLORS = [
  '#9af665',
  '#44b305',
  '#ef6cdf',
  '#ed12d3',
  '#ff975c',
  '#fb5b00',
  '#69d1f2',
  '#0989b2',
  '#fb609e',
  '#fa0064',
  '#73e8d7',
  '#14a38e',
  '#ffb65c',
  '#ff8d00',
  '#5eb4fc',
  '#0089ff',
  '#755df6',
  '#2c06f9'
] as const;
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

function parsePositiveIntEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeRenderScale(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(3, Math.max(1, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.min(3, Math.max(1, parsed));
    }
  }
  return 1;
}

function normalizeGradientAngle(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(360, Math.max(0, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return Math.min(360, Math.max(0, parsed));
    }
  }
  return Math.floor(Math.random() * 361);
}

function normalizeHexColor(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '';
}

function srgbChannelToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string) {
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);
  return (
    0.2126 * srgbChannelToLinear(red) +
    0.7152 * srgbChannelToLinear(green) +
    0.0722 * srgbChannelToLinear(blue)
  );
}

function contrastRatio(left: string, right: string) {
  const leftLum = relativeLuminance(left);
  const rightLum = relativeLuminance(right);
  const lighter = Math.max(leftLum, rightLum);
  const darker = Math.min(leftLum, rightLum);
  return (lighter + 0.05) / (darker + 0.05);
}

function randomItem<T>(items: T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickContrastingPaletteColor(baseColor: string, excluded = new Set<string>()) {
  const candidates = HIGH_CONTRAST_COLORS
    .filter((candidate) => !excluded.has(candidate))
    .map((candidate) => ({ candidate, contrast: contrastRatio(baseColor, candidate) }))
    .sort((left, right) => right.contrast - left.contrast);
  if (candidates.length === 0) return baseColor;
  const bestCandidates = candidates.filter((item, index) => index < 5 && item.contrast >= 2.4);
  return randomItem((bestCandidates.length > 0 ? bestCandidates : candidates).map((item) => item.candidate));
}

function pickOffsetPaletteColor(baseColor: string) {
  const baseIndex = HIGH_CONTRAST_COLORS.indexOf(baseColor as (typeof HIGH_CONTRAST_COLORS)[number]);
  if (baseIndex < 0) return baseColor;
  const offset = Math.max(1, Math.floor(HIGH_CONTRAST_COLORS.length * 0.25));
  return HIGH_CONTRAST_COLORS[(baseIndex + offset) % HIGH_CONTRAST_COLORS.length];
}

function resolveGradientColors(color1: unknown, color2: unknown) {
  const normalized1 = normalizeHexColor(color1);
  const normalized2 = normalizeHexColor(color2);
  if (normalized1 && normalized2) return [normalized1, normalized2] as const;
  if (normalized1) return [normalized1, pickContrastingPaletteColor(normalized1, new Set([normalized1]))] as const;
  if (normalized2) return [pickContrastingPaletteColor(normalized2, new Set([normalized2])), normalized2] as const;
  const first = randomItem([...HIGH_CONTRAST_COLORS]);
  const second = pickOffsetPaletteColor(first);
  return [first, second] as const;
}

function resolveFontPath(fileName: string) {
  const candidates = [
    join(appDir, 'assets', 'fonts', fileName),
    join(appRootDir, 'assets', 'fonts', fileName)
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  if (!matched) {
    throw new Error(`style sticker font is missing: ${fileName}`);
  }
  return matched;
}

function resolveOptionalFontPath(fileName: string) {
  const candidates = [
    join(appDir, 'assets', 'fonts', fileName),
    join(appRootDir, 'assets', 'fonts', fileName)
  ];
  return candidates.find((candidate) => existsSync(candidate)) || '';
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
      console.warn(`[style-sticker] failed to register fallback font: ${descriptor.family}`);
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
  offsetX = 0,
  offsetY = 0
) {
  const angle = ((angleDeg - 90) * Math.PI) / 180;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const halfLength = (Math.abs(dx) * width + Math.abs(dy) * height) / 2;
  const centerX = offsetX + width / 2;
  const centerY = offsetY + height / 2;
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
  const context = canvas.getContext('2d');
  context.drawImage(sourceCanvas, x, y);
  return canvas;
}

/**
 * Fill enclosed interior regions on a canvas (e.g. inside 口、国、回).
 * Uses edge-seeded flood fill: any transparent pixel NOT reachable from the
 * canvas border is interior and filled white.
 *
 * Also propagates opacity through the inner antialiased band (partial-alpha
 * pixels between the filled interior and the opaque stroke body) to prevent
 * a visible "white seam" after gradient compositing. The propagation starts
 * from filled pixels and stops at fully opaque pixels — so it never reaches
 * the OUTER antialiased edge.
 */
function fillEnclosedRegions(canvas: Canvas): void {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const total = width * height;

  // BFS from all 4 canvas edges to mark exterior-reachable background pixels.
  const exterior = new Uint8Array(total);
  const stack = new Int32Array(total);
  let stackTop = -1;

  const enqueue = (i: number) => {
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) {
      exterior[i] = 1;
      stack[++stackTop] = i;
    }
  };

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (stackTop >= 0) {
    const i = stack[stackTop--];
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) enqueue(i - 1);
    if (x < width - 1) enqueue(i + 1);
    if (y > 0) enqueue(i - width);
    if (y < height - 1) enqueue(i + width);
  }

  // Fill enclosed transparent pixels with opaque white.
  let modified = false;
  const filled = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    if (data[i * 4 + 3] <= 16 && exterior[i] === 0) {
      const off = i * 4;
      data[off] = 255;
      data[off + 1] = 255;
      data[off + 2] = 255;
      data[off + 3] = 255;
      filled[i] = 1;
      modified = true;
    }
  }

  if (modified) {
    // Propagate from filled pixels through the inner AA band (partial alpha,
    // non-exterior) until hitting fully opaque stroke body (α=255).
    stackTop = -1;
    for (let i = 0; i < total; i += 1) {
      if (filled[i]) stack[++stackTop] = i;
    }
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
      const x = i % width;
      const y = (i - x) / width;
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
      Math.max(
        Math.abs(controls.shadow.offsetX),
        Math.abs(controls.shadow.offsetY),
      ) +
      4,
  );
}

const glyphMeasureCanvas: Canvas = createCanvas(1, 1);
const glyphMeasureContext = glyphMeasureCanvas.getContext('2d');
const glyphMeasureCache = new Map<string, GlyphMeasurement>();

function measureGlyphWithCanvas(
  grapheme: string,
  fontSize: number,
  flavor: StickerFlavor,
): GlyphMeasurement {
  const cacheKey = `${flavor}:${fontSize}:${grapheme}`;
  const cached = glyphMeasureCache.get(cacheKey);
  if (cached) return cached;

  glyphMeasureContext.font = fontSpec(flavor, fontSize);
  glyphMeasureContext.textBaseline = 'alphabetic';
  const metrics = glyphMeasureContext.measureText(grapheme);
  const left = metrics.actualBoundingBoxLeft || 0;
  const right = metrics.actualBoundingBoxRight || metrics.width;
  const ascent = metrics.actualBoundingBoxAscent || fontSize * 0.82;
  const descent = metrics.actualBoundingBoxDescent || fontSize * 0.18;
  const result: GlyphMeasurement = {
    advanceWidth: metrics.width || right + left || fontSize,
    left,
    right,
    ascent,
    descent,
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
  const horizontalSkewTangent = Math.tan((skewDeg[0] * Math.PI) / 180);
  const verticalSkewTangent = Math.tan((skewDeg[1] * Math.PI) / 180);

  context.font = fontSpec(controls.flavor, controls.fontSize);
  context.textAlign = 'left';
  context.textBaseline = 'alphabetic';
  context.lineJoin = 'round';
  context.miterLimit = 2;

  for (const placement of layout.placements) {
    context.save();
    context.translate(originX + placement.x, originY + placement.baselineY);
    if (placement.skew) {
      if (scaleX !== 1 || scaleY !== 1) {
        context.scale(scaleX, scaleY);
      }
      if (rotationRad !== 0) {
        context.rotate(-rotationRad);
      }
      if (horizontalSkewTangent !== 0) {
        context.transform(1, 0, horizontalSkewTangent, 1, 0, 0);
      }
      if (verticalSkewTangent !== 0) {
        context.transform(1, verticalSkewTangent, 0, 1, 0, 0);
      }
    }
    painter(context, placement.grapheme);
    context.restore();
  }
}

async function renderStickerBuffer(
  text: string,
  flavor: StickerFlavor,
  colors: readonly [string, string],
  renderScale = 1,
  gradientAngle = normalizeGradientAngle(undefined),
) {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error('text is required');
  }

  const controls = normalizeStickerControls({
    text: trimmedText,
    flavor,
    fontSize: BASE_FONT_SIZE * renderScale,
    envelope: { colors: [...colors], gradientAngle }
  });

  await ensureFontLoaded(controls.flavor);

  const baseTransform = sharedFontGlyphTransform(controls.flavor);
  const glyphTransform = controls.tilt
    ? baseTransform
    : { scale: baseTransform.scale, rotationDeg: 0, skewDeg: [0, 0] as [number, number] };

  const layout = createStickerLayout(trimmedText, {
    fontSize: controls.fontSize,
    letterSpacing: controls.letterSpacing,
    lineHeight: controls.lineHeight,
    glyphTransform,
    alternatingOffset: controls.peak ? controls.alternatingOffset : 0,
    measureGlyph: (grapheme, fontSize) => measureGlyphWithCanvas(grapheme, fontSize, controls.flavor)
  });
  const padding = calculateWorkingPadding(controls);
  const workingWidth = Math.max(1, Math.ceil(layout.bounds.maxX - layout.bounds.minX + padding * 2));
  const workingHeight = Math.max(1, Math.ceil(layout.bounds.maxY - layout.bounds.minY + padding * 2));
  const originX = padding - layout.bounds.minX;
  const originY = padding - layout.bounds.minY;

  const outputCanvas: Canvas = createCanvas(workingWidth, workingHeight);
  const outputContext = outputCanvas.getContext('2d', { alpha: true });
  const gradientStops = resolveGradientStops(controls.envelope.colors);

  /** Draw non-emoji glyphs with stroke + fill (produces dilated outline shape). */
  const drawStrokeAndFill = (
    context: SKRSContext2D,
    lineWidth: number,
    ox = originX,
    oy = originY,
  ) => {
    context.lineWidth = lineWidth;
    context.lineJoin = 'round';
    context.lineCap = 'round';
    context.miterLimit = 2;
    drawPlacedGlyphs(context, controls, layout, ox, oy, (current, grapheme) => {
      if (isEmojiGrapheme(grapheme)) return;
      current.strokeText(grapheme, 0, 0);
      current.fillText(grapheme, 0, 0);
    });
  };

  /** Draw non-emoji glyphs with fill only. */
  const drawFillOnly = (
    context: SKRSContext2D,
    ox = originX,
    oy = originY,
  ) => {
    drawPlacedGlyphs(context, controls, layout, ox, oy, (current, grapheme) => {
      if (isEmojiGrapheme(grapheme)) return;
      current.fillText(grapheme, 0, 0);
    });
  };

  if (controls.flavor === 'snh') {
    const bandWidth = controls.envelope.outlineStrokeWidth;
    const edgeWidth = controls.envelope.edgeWidth;

    // Layer 1: Envelope — dilated outline filled with gradient
    const envelopeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const envelopeCtx = envelopeCanvas.getContext('2d');
    envelopeCtx.fillStyle = '#ffffff';
    envelopeCtx.strokeStyle = '#ffffff';
    drawStrokeAndFill(envelopeCtx, bandWidth * 2);
    fillEnclosedRegions(envelopeCanvas);
    // Color with gradient via source-in compositing
    envelopeCtx.globalCompositeOperation = 'source-in';
    envelopeCtx.fillStyle = createGradient(
      envelopeCtx, workingWidth, workingHeight,
      controls.envelope.gradientAngle,
      [gradientStops[0], gradientStops[gradientStops.length - 1]]
    );
    envelopeCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(envelopeCanvas, 0, 0);

    // Layer 2: Edge band — darkened ring between outer and inner boundary
    if (edgeWidth > 0 && controls.envelope.edgeOpacity > 0) {
      const edgeCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      const edgeCtx = edgeCanvas.getContext('2d');
      // Draw outer boundary (same as envelope)
      edgeCtx.fillStyle = '#ffffff';
      edgeCtx.strokeStyle = '#ffffff';
      drawStrokeAndFill(edgeCtx, bandWidth * 2);
      fillEnclosedRegions(edgeCanvas);
      // Build inner boundary on a separate canvas (also needs fillEnclosedRegions)
      const innerCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      const innerCtx = innerCanvas.getContext('2d');
      innerCtx.fillStyle = '#ffffff';
      innerCtx.strokeStyle = '#ffffff';
      drawStrokeAndFill(innerCtx, Math.max(0, (bandWidth - edgeWidth) * 2));
      fillEnclosedRegions(innerCanvas);
      // Subtract inner from outer to leave only the edge ring
      edgeCtx.globalCompositeOperation = 'destination-out';
      edgeCtx.drawImage(innerCanvas, 0, 0);
      // Color the edge ring with darkened gradient
      edgeCtx.globalCompositeOperation = 'source-in';
      edgeCtx.fillStyle = createGradient(
        edgeCtx, workingWidth, workingHeight,
        controls.envelope.gradientAngle,
        [darken(gradientStops[0], 0.45), darken(gradientStops[gradientStops.length - 1], 0.45)]
      );
      edgeCtx.fillRect(0, 0, workingWidth, workingHeight);
      // Composite edge onto output with multiply blend
      outputContext.save();
      outputContext.globalAlpha = controls.envelope.edgeOpacity;
      outputContext.globalCompositeOperation = 'multiply';
      outputContext.drawImage(edgeCanvas, 0, 0);
      outputContext.restore();
    }

    // Layer 3: Inner shadow (uses canvas blur filter)
    if (controls.shadow.opacity > 0) {
      const shadowCanvas: Canvas = createCanvas(workingWidth, workingHeight);
      const shadowCtx = shadowCanvas.getContext('2d');
      // Draw the envelope shape as clip
      shadowCtx.fillStyle = '#ffffff';
      shadowCtx.strokeStyle = '#ffffff';
      drawStrokeAndFill(shadowCtx, bandWidth * 2);
      fillEnclosedRegions(shadowCanvas);
      // Draw blurred shadow inside the envelope
      shadowCtx.globalCompositeOperation = 'source-atop';
      shadowCtx.fillStyle = controls.shadow.color;
      shadowCtx.filter = `blur(${controls.shadow.blur}px)`;
      drawPlacedGlyphs(
        shadowCtx, controls, layout,
        originX + controls.shadow.offsetX,
        originY + controls.shadow.offsetY,
        (current, grapheme) => {
          if (isEmojiGrapheme(grapheme)) return;
          current.fillText(grapheme, 0, 0);
        }
      );
      shadowCtx.filter = 'none';
      // Composite shadow onto output with multiply blend
      outputContext.save();
      outputContext.globalAlpha = controls.shadow.opacity;
      outputContext.globalCompositeOperation = 'multiply';
      outputContext.drawImage(shadowCanvas, 0, 0);
      outputContext.restore();
    }

    // Layer 4: White glyph fill on top
    outputContext.fillStyle = '#ffffff';
    drawFillOnly(outputContext);

  } else {
    // bs (字节范) flavor
    const rimWidth = controls.envelope.outlineStrokeWidth + controls.envelope.edgeWidth;

    // Layer 1: Deep outline — darkened gradient fill
    const deepCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const deepCtx = deepCanvas.getContext('2d');
    deepCtx.fillStyle = '#ffffff';
    deepCtx.strokeStyle = '#ffffff';
    drawStrokeAndFill(deepCtx, rimWidth * 2);
    fillEnclosedRegions(deepCanvas);
    deepCtx.globalCompositeOperation = 'source-in';
    deepCtx.fillStyle = createGradient(
      deepCtx, workingWidth, workingHeight,
      controls.envelope.gradientAngle,
      [darken(gradientStops[0], 0.42), darken(gradientStops[gradientStops.length - 1], 0.42)]
    );
    deepCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(deepCanvas, 0, 0);

    // Layer 2: Glyph fill — main gradient
    const glyphCanvas: Canvas = createCanvas(workingWidth, workingHeight);
    const glyphCtx = glyphCanvas.getContext('2d');
    glyphCtx.fillStyle = '#ffffff';
    drawFillOnly(glyphCtx);
    glyphCtx.globalCompositeOperation = 'source-in';
    glyphCtx.fillStyle = createGradient(
      glyphCtx, workingWidth, workingHeight,
      controls.envelope.gradientAngle,
      [gradientStops[0], gradientStops[gradientStops.length - 1]]
    );
    glyphCtx.fillRect(0, 0, workingWidth, workingHeight);
    outputContext.drawImage(glyphCanvas, 0, 0);
  }

  // Emoji overlay (drawn directly, no mask processing)
  drawPlacedGlyphs(outputContext, controls, layout, originX, originY, (current, grapheme) => {
    if (!isEmojiGrapheme(grapheme)) return;
    current.fillText(grapheme, 0, 0);
  });

  const croppedCanvas = cropCanvasAlpha(outputCanvas);
  const contentHeight = Math.max(1, layout.bounds.maxY - layout.bounds.minY);
  const exportScale = (BASE_FONT_SIZE * renderScale) / contentHeight;
  const resizedCanvas = resizeCanvasByScale(
    croppedCanvas,
    exportScale,
    Math.round(MAX_OUTPUT_EDGE * renderScale)
  );
  const exportCanvas = padCanvas(resizedCanvas, controls.padding.x, controls.padding.y);
  return exportCanvas.toBuffer('image/png');
}

export async function closeStyleStickerRenderer() {
  return;
}

const RENDER_CACHE_TTL_MS = 60_000;
const RENDER_CACHE_MAX_ENTRIES = 20;
const renderResultCache = new Map<string, { image: Buffer; colors: readonly [string, string]; renderScale: number; gradientAngle: number; expiresAt: number }>();

function pruneRenderCache() {
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of renderResultCache) {
    if (entry.expiresAt <= now) renderResultCache.delete(key);
  }
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const sorted = [...renderResultCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = sorted.slice(0, sorted.length - RENDER_CACHE_MAX_ENTRIES);
  for (const [key] of toRemove) renderResultCache.delete(key);
}

export async function renderStyleStickerImage(
  text: string,
  flavor: StickerFlavor,
  options: {
    color1?: unknown;
    color2?: unknown;
    scale?: unknown;
    gradientAngle?: unknown;
  } = {},
) {
  const colors = resolveGradientColors(options.color1, options.color2);
  const renderScale = normalizeRenderScale(options.scale);
  const gradientAngle = normalizeGradientAngle(options.gradientAngle);

  const cacheKey = `${flavor}:${text}:${colors[0]}:${colors[1]}:${renderScale}:${gradientAngle}`;
  const cached = renderResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { image: cached.image, colors: cached.colors, renderScale: cached.renderScale, gradientAngle: cached.gradientAngle };
  }

  const image = await runStyleStickerRenderTask(() => renderStickerBuffer(text, flavor, colors, renderScale, gradientAngle));
  pruneRenderCache();
  renderResultCache.set(cacheKey, { image, colors, renderScale, gradientAngle, expiresAt: Date.now() + RENDER_CACHE_TTL_MS });
  return { image, colors, renderScale, gradientAngle };
}

async function handleStyleSticker(req: Request, res: Response, flavor: StickerFlavor) {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  try {
    const { image, colors, renderScale, gradientAngle } = await renderStyleStickerImage(text, flavor, {
      color1: req.query.color1,
      color2: req.query.color2,
      scale: req.query.scale,
      gradientAngle: req.query.gradientAngle ?? req.query.ga,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Gradient-Color-1', colors[0]);
    res.setHeader('X-Gradient-Color-2', colors[1]);
    res.setHeader('X-Gradient-Angle', String(gradientAngle));
    res.setHeader('X-Render-Scale', String(renderScale));
    res.send(image);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'failed to render sticker' });
  }
}

export async function renderByteStyle(req: Request, res: Response) {
  await handleStyleSticker(req, res, 'bs');
}

export async function renderScaleNewHeights(req: Request, res: Response) {
  await handleStyleSticker(req, res, 'snh');
}
