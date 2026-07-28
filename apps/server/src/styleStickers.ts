import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderStickerToImage,
  type NodeStickerFontFiles,
  type StickerFlavor,
  type StickerImageResult
} from '@syru/byted-sticker-generator/node';
import type { Request, Response } from 'express';
import { passiveInteractionConfig } from './config.js';
import { createConcurrencyLimiter } from './utils/concurrency.js';

export type { StickerFlavor };

/** 限制导出图片最长边，避免机器人上传过大图片 */
const MAX_OUTPUT_EDGE = 4096;
/** 卡片色板与随机配色候选，与 UI 高对比配色保持一致 */
export const STYLE_STICKER_COLOR_SWATCHES = [
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

const STYLE_STICKER_RENDER_CONCURRENCY = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_CONCURRENCY, 2);
const STYLE_STICKER_RENDER_QUEUE_MAX = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_QUEUE_MAX, 20);
const STYLE_STICKER_RENDER_TIMEOUT_MS = parsePositiveIntEnv(process.env.DOGEBOT_STYLE_STICKER_RENDER_TIMEOUT_MS, 20_000);
const STYLE_STICKER_FONT_FILES = resolveStyleStickerFontFiles();
const runStyleStickerRenderTask = createConcurrencyLimiter({
  name: 'style-sticker-render',
  limit: STYLE_STICKER_RENDER_CONCURRENCY,
  maxQueue: STYLE_STICKER_RENDER_QUEUE_MAX,
  taskTimeoutMs: STYLE_STICKER_RENDER_TIMEOUT_MS
});

const RENDER_CACHE_TTL_MS = 60_000;
const RENDER_CACHE_MAX_ENTRIES = 20;
const renderResultCache = new Map<string, {
  image: Buffer;
  mime: string;
  colors: readonly [string, string];
  renderScale: number;
  gradientAngle: number;
  expiresAt: number;
}>();

interface ResolvedStyleStickerInput {
  text: string;
  flavor: StickerFlavor;
  colors: readonly [string, string];
  renderScale: number;
  gradientAngle: number;
  flashStops: number | null;
}

function parsePositiveIntEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStyleStickerFontFiles(): NodeStickerFontFiles {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const distAssetsDir = join(moduleDir, 'assets', 'fonts');
  const sourceAssetsDir = join(moduleDir, '..', 'assets', 'fonts');
  const assetsDir = existsSync(distAssetsDir) ? distAssetsDir : sourceAssetsDir;
  const fontPath = (file: string) => join(assetsDir, file);
  return {
    snh: fontPath('DouyinSansBold.woff2'),
    bs: fontPath('YouSheBiaoTiHei.ttf'),
    appleColorEmoji: fontPath('AppleColorEmoji.ttf'),
    appleSymbols: fontPath('AppleSymbols.ttf'),
    notoColorEmoji: fontPath('NotoColorEmoji.ttf'),
    notoSansSymbols2: fontPath('NotoSansSymbols2-Regular.ttf')
  };
}

function normalizeRenderScale(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.min(3, Math.max(1, parsed));
  return 1;
}

function normalizeGradientAngle(value: unknown) {
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed === 'number' && Number.isFinite(parsed)) return Math.min(360, Math.max(0, parsed));
  return Math.floor(Math.random() * 361);
}

function normalizeHexColor(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '';
}

/** HDR 高亮 EV：1-100 之外或非法一律视为关闭 HDR */
export function parseEvParam(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(typeof value === 'string' ? value.trim() : value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  return parsed;
}

function srgbChannelToLinear(channel: number) {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hexColor: string) {
  const red = Number.parseInt(hexColor.slice(1, 3), 16);
  const green = Number.parseInt(hexColor.slice(3, 5), 16);
  const blue = Number.parseInt(hexColor.slice(5, 7), 16);
  return 0.2126 * srgbChannelToLinear(red) + 0.7152 * srgbChannelToLinear(green) + 0.0722 * srgbChannelToLinear(blue);
}

function contrastRatio(left: string, right: string) {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right));
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function randomItem<T>(items: readonly T[]) {
  return items[Math.floor(Math.random() * items.length)];
}

function pickContrastingPaletteColor(baseColor: string, excluded = new Set<string>()) {
  const candidates = STYLE_STICKER_COLOR_SWATCHES
    .filter((candidate) => !excluded.has(candidate))
    .map((candidate) => ({ candidate, contrast: contrastRatio(baseColor, candidate) }))
    .sort((left, right) => right.contrast - left.contrast);
  if (candidates.length === 0) return baseColor;
  const bestCandidates = candidates.filter((item, index) => index < 5 && item.contrast >= 2.4);
  return randomItem((bestCandidates.length > 0 ? bestCandidates : candidates).map((item) => item.candidate));
}

function pickOffsetPaletteColor(baseColor: string) {
  const baseIndex = STYLE_STICKER_COLOR_SWATCHES.indexOf(baseColor as (typeof STYLE_STICKER_COLOR_SWATCHES)[number]);
  if (baseIndex < 0) return baseColor;
  const offset = Math.max(1, Math.floor(STYLE_STICKER_COLOR_SWATCHES.length * 0.25));
  return STYLE_STICKER_COLOR_SWATCHES[(baseIndex + offset) % STYLE_STICKER_COLOR_SWATCHES.length];
}

function resolveGradientColors(color1: unknown, color2: unknown): readonly [string, string] {
  const normalized1 = normalizeHexColor(color1);
  const normalized2 = normalizeHexColor(color2);
  if (normalized1 && normalized2) return [normalized1, normalized2];
  if (normalized1) return [normalized1, pickContrastingPaletteColor(normalized1, new Set([normalized1]))];
  if (normalized2) return [pickContrastingPaletteColor(normalized2, new Set([normalized2])), normalized2];
  const first = randomItem(STYLE_STICKER_COLOR_SWATCHES);
  return [first, pickOffsetPaletteColor(first)];
}

function resolveStyleStickerInput(
  text: string,
  flavor: StickerFlavor,
  options: { color1?: unknown; color2?: unknown; scale?: unknown; gradientAngle?: unknown; ev?: unknown }
): ResolvedStyleStickerInput {
  return {
    text,
    flavor,
    colors: resolveGradientColors(options.color1, options.color2),
    renderScale: normalizeRenderScale(options.scale),
    gradientAngle: normalizeGradientAngle(options.gradientAngle),
    flashStops: parseEvParam(options.ev)
  };
}

function renderCacheKey(input: ResolvedStyleStickerInput) {
  return [
    input.flavor,
    input.text,
    input.colors[0],
    input.colors[1],
    input.renderScale,
    input.gradientAngle,
    input.flashStops ?? ''
  ].join(':');
}

function pruneRenderCache() {
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of renderResultCache) {
    if (entry.expiresAt <= now) renderResultCache.delete(key);
  }
  if (renderResultCache.size <= RENDER_CACHE_MAX_ENTRIES) return;
  const sorted = [...renderResultCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  for (const [key] of sorted.slice(0, sorted.length - RENDER_CACHE_MAX_ENTRIES)) renderResultCache.delete(key);
}

export async function closeStyleStickerRenderer() {
  return;
}

async function renderStyleStickerFile(input: ResolvedStyleStickerInput) {
  const cacheKey = renderCacheKey(input);
  const cached = renderResultCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { image: cached.image, mime: cached.mime, colors: cached.colors, renderScale: cached.renderScale, gradientAngle: cached.gradientAngle };
  }

  const flash = input.flashStops !== null;
  const rendered: StickerImageResult = await runStyleStickerRenderTask(() =>
    renderStickerToImage(
      {
        text: input.text,
        flavor: input.flavor,
        flash,
        flashStops: input.flashStops ?? undefined,
        envelope: { colors: [...input.colors], gradientAngle: input.gradientAngle }
      },
      {
        fontFiles: STYLE_STICKER_FONT_FILES,
        outputScale: input.renderScale,
        maxOutputEdge: Math.round(MAX_OUTPUT_EDGE * input.renderScale)
      }
    )
  );

  const result = {
    image: rendered.buffer,
    mime: rendered.mime,
    colors: input.colors,
    renderScale: input.renderScale,
    gradientAngle: input.gradientAngle
  };
  pruneRenderCache();
  renderResultCache.set(cacheKey, { ...result, expiresAt: Date.now() + RENDER_CACHE_TTL_MS });
  return result;
}

export async function renderStyleStickerImage(
  text: string,
  flavor: StickerFlavor,
  options: { color1?: unknown; color2?: unknown; scale?: unknown; gradientAngle?: unknown; ev?: unknown } = {}
) {
  return renderStyleStickerFile(resolveStyleStickerInput(text, flavor, options));
}

async function handleStyleSticker(req: Request, res: Response, flavor: StickerFlavor) {
  const rawText = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  // Cap the text at the same absolute limit used by the Feishu command paths.
  const text = rawText.slice(0, passiveInteractionConfig().styleStickerMaxCharsLimit);
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  try {
    const { image, mime, colors, renderScale, gradientAngle } = await renderStyleStickerImage(text, flavor, {
      color1: req.query.color1,
      color2: req.query.color2,
      scale: req.query.scale,
      gradientAngle: req.query.gradientAngle ?? req.query.ga,
      ev: req.query.ev
    });

    const ev = parseEvParam(req.query.ev);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Gradient-Color-1', colors[0]);
    res.setHeader('X-Gradient-Color-2', colors[1]);
    res.setHeader('X-Gradient-Angle', String(gradientAngle));
    res.setHeader('X-Render-Scale', String(renderScale));
    if (ev !== null) res.setHeader('X-HDR-EV', String(ev));
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
