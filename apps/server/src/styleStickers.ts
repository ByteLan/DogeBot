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

type TextLineMetrics = {
  text: string;
  width: number;
  ascent: number;
  descent: number;
};

const BASE_FONT_SIZE = 220;
const MAX_OUTPUT_EDGE = 4096;
const ENVELOPE_ANTIALIAS = 1.1;
const OUTLINE_ANTIALIAS = 0.9;
const ALPHA_THRESHOLD = 16;
const DISTANCE_INF = 1e15;
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

function darkenHexColor(hexColor: string, factor: number) {
  const red = Math.max(0, Math.min(255, Math.round(Number.parseInt(hexColor.slice(1, 3), 16) * factor)));
  const green = Math.max(0, Math.min(255, Math.round(Number.parseInt(hexColor.slice(3, 5), 16) * factor)));
  const blue = Math.max(0, Math.min(255, Math.round(Number.parseInt(hexColor.slice(5, 7), 16) * factor)));
  return `#${red.toString(16).padStart(2, '0')}${green.toString(16).padStart(2, '0')}${blue.toString(16).padStart(2, '0')}`;
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
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

function measureLines(lines: string[], flavor: StickerFlavor, fontSize: number): TextLineMetrics[] {
  const canvas: Canvas = createCanvas(1, 1);
  const context = canvas.getContext('2d');
  context.font = fontSpec(flavor, fontSize);
  context.textBaseline = 'alphabetic';
  return lines.map((line) => {
    const metrics = context.measureText(line || ' ');
    return {
      text: line || ' ',
      width: Math.max(metrics.width, metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight),
      ascent: metrics.actualBoundingBoxAscent || fontSize * 0.82,
      descent: metrics.actualBoundingBoxDescent || fontSize * 0.18,
    };
  });
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

function resizeIfNeeded(sourceCanvas: Canvas) {
  const longestEdge = Math.max(sourceCanvas.width, sourceCanvas.height);
  if (longestEdge <= MAX_OUTPUT_EDGE) return sourceCanvas;

  const scale = MAX_OUTPUT_EDGE / longestEdge;
  const width = Math.max(1, Math.round(sourceCanvas.width * scale));
  const height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const output: Canvas = createCanvas(width, height);
  const context = output.getContext('2d');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(sourceCanvas, 0, 0, width, height);
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

type BinaryMask = {
  width: number;
  height: number;
  data: Uint8ClampedArray;
};

function extractAlphaChannel(rgba: Uint8ClampedArray) {
  const alpha = new Uint8ClampedArray(rgba.length / 4);
  for (let index = 0; index < alpha.length; index += 1) {
    alpha[index] = rgba[index * 4 + 3];
  }
  return alpha;
}

function thresholdAlphaMask(alpha: Uint8ClampedArray, width: number, height: number, threshold: number): BinaryMask {
  const data = new Uint8ClampedArray(width * height);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = alpha[index] >= threshold ? 255 : 0;
  }
  return { width, height, data };
}

function cloneMask(mask: BinaryMask): BinaryMask {
  return {
    width: mask.width,
    height: mask.height,
    data: new Uint8ClampedArray(mask.data),
  };
}

function invertMask(mask: BinaryMask): BinaryMask {
  const data = new Uint8ClampedArray(mask.data.length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = mask.data[index] === 0 ? 255 : 0;
  }
  return { width: mask.width, height: mask.height, data };
}

function calculateSeparation(source: Float64Array, current: number, previous: number) {
  return (
    (source[current] + current * current - (source[previous] + previous * previous)) /
    (2 * current - 2 * previous)
  );
}

function transformDistanceAxis(source: Float64Array, length: number, target: Float64Array) {
  const vertices = new Int32Array(length);
  const boundaries = new Float64Array(length + 1);
  let hullSize = 0;

  vertices[0] = 0;
  boundaries[0] = Number.NEGATIVE_INFINITY;
  boundaries[1] = Number.POSITIVE_INFINITY;

  for (let position = 1; position < length; position += 1) {
    let intersection = calculateSeparation(source, position, vertices[hullSize]);
    while (intersection <= boundaries[hullSize]) {
      hullSize -= 1;
      intersection = calculateSeparation(source, position, vertices[hullSize]);
    }
    hullSize += 1;
    vertices[hullSize] = position;
    boundaries[hullSize] = intersection;
    boundaries[hullSize + 1] = Number.POSITIVE_INFINITY;
  }

  hullSize = 0;
  for (let position = 0; position < length; position += 1) {
    while (boundaries[hullSize + 1] < position) {
      hullSize += 1;
    }
    const distance = position - vertices[hullSize];
    target[position] = distance * distance + source[vertices[hullSize]];
  }
}

function computeSquaredDistanceTransform(mask: BinaryMask) {
  const { width, height } = mask;
  const temporary = new Float64Array(width * height);
  const distances = new Float64Array(width * height);
  const column = new Float64Array(Math.max(width, height));
  const columnDistances = new Float64Array(Math.max(width, height));

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) {
      column[y] = mask.data[y * width + x] > 0 ? 0 : DISTANCE_INF;
    }
    transformDistanceAxis(column, height, columnDistances);
    for (let y = 0; y < height; y += 1) {
      temporary[y * width + x] = columnDistances[y];
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      column[x] = temporary[y * width + x];
    }
    transformDistanceAxis(column, width, columnDistances);
    for (let x = 0; x < width; x += 1) {
      distances[y * width + x] = columnDistances[x];
    }
  }

  return distances;
}

type MaskBBox = { minX: number; minY: number; maxX: number; maxY: number };

function computeMaskBBox(mask: BinaryMask): MaskBBox {
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    const rowOffset = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[rowOffset + x] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

function extractMaskROI(mask: BinaryMask, left: number, top: number, roiWidth: number, roiHeight: number): BinaryMask {
  const data = new Uint8ClampedArray(roiWidth * roiHeight);
  for (let y = 0; y < roiHeight; y += 1) {
    const srcY = top + y;
    if (srcY < 0 || srcY >= mask.height) continue;
    const srcRowOffset = srcY * mask.width;
    const dstRowOffset = y * roiWidth;
    for (let x = 0; x < roiWidth; x += 1) {
      const srcX = left + x;
      if (srcX < 0 || srcX >= mask.width) continue;
      data[dstRowOffset + x] = mask.data[srcRowOffset + srcX];
    }
  }
  return { width: roiWidth, height: roiHeight, data };
}

function embedROIIntoFullMask(roi: Uint8ClampedArray, roiWidth: number, roiHeight: number, left: number, top: number, fullWidth: number, fullHeight: number): BinaryMask {
  const data = new Uint8ClampedArray(fullWidth * fullHeight);
  for (let y = 0; y < roiHeight; y += 1) {
    const dstY = top + y;
    if (dstY < 0 || dstY >= fullHeight) continue;
    const srcRowOffset = y * roiWidth;
    const dstRowOffset = dstY * fullWidth;
    for (let x = 0; x < roiWidth; x += 1) {
      const dstX = left + x;
      if (dstX < 0 || dstX >= fullWidth) continue;
      data[dstRowOffset + dstX] = roi[srcRowOffset + x];
    }
  }
  return { width: fullWidth, height: fullHeight, data };
}

function dilateMaskRound(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return cloneMask(mask);
  const squaredDistances = computeSquaredDistanceTransform(mask);
  const data = new Uint8ClampedArray(mask.data.length);
  const radiusSquared = radius * radius;
  for (let index = 0; index < data.length; index += 1) {
    data[index] = squaredDistances[index] <= radiusSquared ? 255 : 0;
  }
  return { width: mask.width, height: mask.height, data };
}

function dilateMaskRoundROI(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return cloneMask(mask);
  const bbox = computeMaskBBox(mask);
  if (bbox.maxX < 0) return cloneMask(mask);

  const expand = Math.ceil(radius) + 1;
  const roiLeft = Math.max(0, bbox.minX - expand);
  const roiTop = Math.max(0, bbox.minY - expand);
  const roiRight = Math.min(mask.width - 1, bbox.maxX + expand);
  const roiBottom = Math.min(mask.height - 1, bbox.maxY + expand);
  const roiWidth = roiRight - roiLeft + 1;
  const roiHeight = roiBottom - roiTop + 1;

  const roiPixels = roiWidth * roiHeight;
  const fullPixels = mask.width * mask.height;
  if (roiPixels >= fullPixels * 0.7) {
    return dilateMaskRound(mask, radius);
  }

  const roiMask = extractMaskROI(mask, roiLeft, roiTop, roiWidth, roiHeight);
  const squaredDistances = computeSquaredDistanceTransform(roiMask);
  const roiData = new Uint8ClampedArray(roiPixels);
  const radiusSquared = radius * radius;
  for (let i = 0; i < roiPixels; i += 1) {
    roiData[i] = squaredDistances[i] <= radiusSquared ? 255 : 0;
  }
  return embedROIIntoFullMask(roiData, roiWidth, roiHeight, roiLeft, roiTop, mask.width, mask.height);
}

function erodeMaskRound(mask: BinaryMask, radius: number): BinaryMask {
  if (radius <= 0) return cloneMask(mask);
  return invertMask(dilateMaskRound(invertMask(mask), radius));
}

function subtractMask(source: BinaryMask, subtractor: BinaryMask): BinaryMask {
  const data = new Uint8ClampedArray(source.data.length);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = source.data[index] > 0 && subtractor.data[index] === 0 ? 255 : 0;
  }
  return { width: source.width, height: source.height, data };
}

function fillEnclosedRegions(mask: BinaryMask): BinaryMask {
  const { width, height, data } = mask;
  const exterior = new Uint8Array(data.length);
  const stack: number[] = [];

  const pushIfBackground = (index: number) => {
    if (data[index] === 0 && exterior[index] === 0) {
      exterior[index] = 1;
      stack.push(index);
    }
  };

  for (let x = 0; x < width; x += 1) {
    pushIfBackground(x);
    pushIfBackground((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    pushIfBackground(y * width);
    pushIfBackground(y * width + width - 1);
  }

  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) pushIfBackground(index - 1);
    if (x < width - 1) pushIfBackground(index + 1);
    if (y > 0) pushIfBackground(index - width);
    if (y < height - 1) pushIfBackground(index + width);
  }

  const result = new Uint8ClampedArray(data.length);
  for (let index = 0; index < data.length; index += 1) {
    result[index] = data[index] > 0 || exterior[index] === 0 ? 255 : 0;
  }

  return { width, height, data: result };
}

function clampUnitInterval(value: number) {
  return Math.min(1, Math.max(0, value));
}

function createAntialiasedAlpha(mask: BinaryMask, featherRadius: number) {
  const outsideDistances = computeSquaredDistanceTransform(mask);
  const insideDistances = computeSquaredDistanceTransform(invertMask(mask));
  const alpha = new Uint8ClampedArray(mask.data.length);
  const feather = Math.max(0.01, featherRadius);

  for (let index = 0; index < alpha.length; index += 1) {
    const signedDistance = Math.sqrt(outsideDistances[index]) - Math.sqrt(insideDistances[index]);
    const normalized = clampUnitInterval(0.5 - signedDistance / (2 * feather));
    alpha[index] = Math.round(normalized * 255);
  }

  return alpha;
}

function createAntialiasedAlphaROI(mask: BinaryMask, featherRadius: number) {
  const bbox = computeMaskBBox(mask);
  if (bbox.maxX < 0) return new Uint8ClampedArray(mask.data.length);

  const expand = Math.ceil(featherRadius) + 2;
  const roiLeft = Math.max(0, bbox.minX - expand);
  const roiTop = Math.max(0, bbox.minY - expand);
  const roiRight = Math.min(mask.width - 1, bbox.maxX + expand);
  const roiBottom = Math.min(mask.height - 1, bbox.maxY + expand);
  const roiWidth = roiRight - roiLeft + 1;
  const roiHeight = roiBottom - roiTop + 1;

  const roiPixels = roiWidth * roiHeight;
  const fullPixels = mask.width * mask.height;
  if (roiPixels >= fullPixels * 0.7) {
    return createAntialiasedAlpha(mask, featherRadius);
  }

  const roiMask = extractMaskROI(mask, roiLeft, roiTop, roiWidth, roiHeight);
  const outsideDistances = computeSquaredDistanceTransform(roiMask);
  const insideDistances = computeSquaredDistanceTransform(invertMask(roiMask));
  const feather = Math.max(0.01, featherRadius);

  const alpha = new Uint8ClampedArray(fullPixels);
  for (let y = 0; y < roiHeight; y += 1) {
    const roiRowOffset = y * roiWidth;
    const fullRowOffset = (roiTop + y) * mask.width;
    for (let x = 0; x < roiWidth; x += 1) {
      const roiIdx = roiRowOffset + x;
      const signedDistance = Math.sqrt(outsideDistances[roiIdx]) - Math.sqrt(insideDistances[roiIdx]);
      const normalized = clampUnitInterval(0.5 - signedDistance / (2 * feather));
      alpha[fullRowOffset + roiLeft + x] = Math.round(normalized * 255);
    }
  }
  return alpha;
}

function maskToCanvas(mask: BinaryMask, softenRadius = 0) {
  const canvas: Canvas = createCanvas(mask.width, mask.height);
  const context = canvas.getContext('2d');
  const imageData = context.createImageData(mask.width, mask.height);
  const alpha = softenRadius > 0 ? createAntialiasedAlphaROI(mask, softenRadius) : mask.data;

  for (let index = 0; index < mask.data.length; index += 1) {
    const rgbaIndex = index * 4;
    imageData.data[rgbaIndex] = 255;
    imageData.data[rgbaIndex + 1] = 255;
    imageData.data[rgbaIndex + 2] = 255;
    imageData.data[rgbaIndex + 3] = alpha[index];
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

let reusableTempCanvas: Canvas | null = null;

function paintMask(
  targetContext: SKRSContext2D,
  maskCanvas: Canvas,
  painter: (context: SKRSContext2D) => void,
  opacity = 1,
  compositeOperation: GlobalCompositeOperation = 'source-over',
) {
  const width = maskCanvas.width;
  const height = maskCanvas.height;
  let temporaryCanvas: Canvas;
  if (reusableTempCanvas && reusableTempCanvas.width === width && reusableTempCanvas.height === height) {
    temporaryCanvas = reusableTempCanvas;
  } else {
    temporaryCanvas = createCanvas(width, height);
    reusableTempCanvas = temporaryCanvas;
  }
  const temporaryContext = temporaryCanvas.getContext('2d');
  temporaryContext.clearRect(0, 0, width, height);
  temporaryContext.globalCompositeOperation = 'source-over';
  temporaryContext.globalAlpha = 1;
  temporaryContext.filter = 'none';

  painter(temporaryContext);
  temporaryContext.globalCompositeOperation = 'destination-in';
  temporaryContext.drawImage(maskCanvas, 0, 0);

  targetContext.save();
  targetContext.globalAlpha = opacity;
  targetContext.globalCompositeOperation = compositeOperation;
  targetContext.drawImage(temporaryCanvas, 0, 0);
  targetContext.restore();
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

  const sourceMaskCanvas: Canvas = createCanvas(workingWidth, workingHeight);
  const sourceMaskContext = sourceMaskCanvas.getContext('2d', { alpha: true });
  sourceMaskContext.clearRect(0, 0, workingWidth, workingHeight);
  sourceMaskContext.fillStyle = '#ffffff';
  drawPlacedGlyphs(sourceMaskContext, controls, layout, originX, originY, (current, grapheme) => {
    if (isEmojiGrapheme(grapheme)) return;
    current.fillText(grapheme, 0, 0);
  });

  const sourceMask = thresholdAlphaMask(
    extractAlphaChannel(sourceMaskContext.getImageData(0, 0, workingWidth, workingHeight).data),
    workingWidth,
    workingHeight,
    ALPHA_THRESHOLD,
  );

  const outputCanvas: Canvas = createCanvas(workingWidth, workingHeight);
  const outputContext = outputCanvas.getContext('2d', { alpha: true });
  const gradientStops = resolveGradientStops(controls.envelope.colors);

  const paintFamilyGradient = (context: SKRSContext2D, stops: string[]) => {
    context.fillStyle = createGradient(
      context,
      workingWidth,
      workingHeight,
      controls.envelope.gradientAngle,
      [stops[0], stops[stops.length - 1]]
    );
    context.fillRect(0, 0, workingWidth, workingHeight);
  };

  const paintSolid = (context: SKRSContext2D, color: string) => {
    context.fillStyle = color;
    context.fillRect(0, 0, workingWidth, workingHeight);
  };

  if (controls.flavor === 'snh') {
    const bandWidth = controls.envelope.outlineStrokeWidth;
    const envelopeMask = fillEnclosedRegions(dilateMaskRoundROI(sourceMask, bandWidth));
    const edgeMask = subtractMask(
      envelopeMask,
      erodeMaskRound(envelopeMask, controls.envelope.edgeWidth),
    );
    const envelopeMaskCanvas = maskToCanvas(envelopeMask, ENVELOPE_ANTIALIAS);
    const edgeMaskCanvas = maskToCanvas(edgeMask, OUTLINE_ANTIALIAS);
    const glyphMaskCanvas = maskToCanvas(sourceMask, OUTLINE_ANTIALIAS);

    paintMask(outputContext, envelopeMaskCanvas, (context) => {
      paintFamilyGradient(context, gradientStops);
    });
    paintMask(
      outputContext,
      edgeMaskCanvas,
      (context) => {
        paintFamilyGradient(
          context,
          gradientStops.map((color) => darken(color, 0.45)),
        );
      },
      controls.envelope.edgeOpacity,
      'multiply',
    );
    if (controls.shadow.opacity > 0) {
      paintMask(
        outputContext,
        envelopeMaskCanvas,
        (context) => {
          context.fillStyle = controls.shadow.color;
          context.filter = `blur(${controls.shadow.blur}px)`;
          drawPlacedGlyphs(
            context,
            controls,
            layout,
            originX + controls.shadow.offsetX,
            originY + controls.shadow.offsetY,
            (current, grapheme) => {
              if (isEmojiGrapheme(grapheme)) return;
              current.fillText(grapheme, 0, 0);
            }
          );
        },
        controls.shadow.opacity,
        'multiply',
      );
    }
    paintMask(outputContext, glyphMaskCanvas, (context) => {
      paintSolid(context, '#ffffff');
    });
  } else {
    const rimWidth = controls.envelope.outlineStrokeWidth + controls.envelope.edgeWidth;
    const deepMask = fillEnclosedRegions(dilateMaskRoundROI(sourceMask, rimWidth));
    const deepMaskCanvas = maskToCanvas(deepMask, ENVELOPE_ANTIALIAS);
    const glyphMaskCanvas = maskToCanvas(sourceMask, OUTLINE_ANTIALIAS);

    paintMask(outputContext, deepMaskCanvas, (context) => {
      paintFamilyGradient(
        context,
        gradientStops.map((color) => darken(color, 0.42)),
      );
    });
    paintMask(outputContext, glyphMaskCanvas, (context) => {
      paintFamilyGradient(context, gradientStops);
    });
  }

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
