import type { Request, Response } from 'express';

type StickerFlavor = 'bs' | 'snh';

type RendererRuntime = {
  baseUrl: string;
  browser: {
    newPage: (options?: object) => Promise<{
      goto: (url: string, options?: object) => Promise<unknown>;
      waitForFunction: (fn: () => unknown, options?: object) => Promise<unknown>;
      evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
      close: () => Promise<void>;
    }>;
    close: () => Promise<void>;
  };
};

const STYLE_STICKER_BASE_URL = process.env.DOGEBOT_STYLE_STICKER_BASE_URL?.trim() || 'https://scale-new-heights.bbyte.cn/';
const STICKER_RENDER_TIMEOUT_MS = Number(process.env.DOGEBOT_STYLE_STICKER_RENDER_TIMEOUT_MS || 30_000);
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

let rendererRuntimePromise: Promise<RendererRuntime> | null = null;

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

function resolveGradientColors(color1: unknown, color2: unknown) {
  const normalized1 = normalizeHexColor(color1);
  const normalized2 = normalizeHexColor(color2);
  if (normalized1 && normalized2) return [normalized1, normalized2] as const;
  if (normalized1) return [normalized1, pickContrastingPaletteColor(normalized1, new Set([normalized1]))] as const;
  if (normalized2) return [pickContrastingPaletteColor(normalized2, new Set([normalized2])), normalized2] as const;
  const first = randomItem([...HIGH_CONTRAST_COLORS]);
  const second = pickContrastingPaletteColor(first, new Set([first]));
  return [first, second] as const;
}

function resolveStyleStickerBaseUrl() {
  if (!STYLE_STICKER_BASE_URL) {
    throw new Error('DOGEBOT_STYLE_STICKER_BASE_URL is required; configure it to your deployed scale-new-heights-generator page URL');
  }
  let url: URL;
  try {
    url = new URL(STYLE_STICKER_BASE_URL);
  } catch {
    throw new Error(`DOGEBOT_STYLE_STICKER_BASE_URL is invalid: ${STYLE_STICKER_BASE_URL}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`DOGEBOT_STYLE_STICKER_BASE_URL must use http or https: ${STYLE_STICKER_BASE_URL}`);
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function loadPlaywrightChromium() {
  try {
    const playwright = await import('playwright');
    if (!playwright.chromium) throw new Error('chromium is unavailable');
    return playwright.chromium;
  } catch (error) {
    throw new Error(
      `playwright is unavailable. Please install it in apps/server and run "npx playwright install chromium". ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function getRendererRuntime(): Promise<RendererRuntime> {
  if (rendererRuntimePromise) return rendererRuntimePromise;
  rendererRuntimePromise = (async () => {
    const chromium = await loadPlaywrightChromium();
    const browser = await chromium.launch({ headless: true });
    return {
      baseUrl: resolveStyleStickerBaseUrl(),
      browser,
    };
  })().catch((error) => {
    rendererRuntimePromise = null;
    throw error;
  });
  return rendererRuntimePromise;
}

export async function closeStyleStickerRenderer() {
  if (!rendererRuntimePromise) return;
  const runtime = await rendererRuntimePromise.catch(() => undefined);
  rendererRuntimePromise = null;
  if (!runtime) return;
  await runtime.browser.close().catch(() => undefined);
}

async function renderStickerBuffer(
  text: string,
  flavor: StickerFlavor,
  colors: readonly [string, string],
  renderScale = 1,
) {
  const runtime = await getRendererRuntime();
  const page = await runtime.browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const url = new URL(runtime.baseUrl);
  url.searchParams.set('t', text);
  url.searchParams.set('fl', flavor);
  url.searchParams.set('gc', colors.map((color) => color.replace('#', '')).join('-'));
  if (renderScale !== 1) {
    url.searchParams.set('scale', String(renderScale));
  }
  try {
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: STICKER_RENDER_TIMEOUT_MS });
    await page.waitForFunction(() => {
      const state = document.documentElement.dataset.stickerRenderState;
      return state === 'ready' || state === 'error';
    }, { timeout: STICKER_RENDER_TIMEOUT_MS });
    const renderError = await page.evaluate(() => document.documentElement.dataset.stickerRenderError || '');
    if (renderError) {
      throw new Error(renderError);
    }
    const dataUrl = await page.evaluate(() => {
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('render canvas not found');
      }
      return canvas.toDataURL('image/png');
    });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return Buffer.from(base64, 'base64');
  } finally {
    await page.close();
  }
}

async function handleStyleSticker(req: Request, res: Response, flavor: StickerFlavor) {
  const text = typeof req.query.text === 'string' ? req.query.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const colors = resolveGradientColors(req.query.color1, req.query.color2);
  const renderScale = normalizeRenderScale(req.query.scale);
  try {
    const image = await renderStickerBuffer(text, flavor, colors, renderScale);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Gradient-Color-1', colors[0]);
    res.setHeader('X-Gradient-Color-2', colors[1]);
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
