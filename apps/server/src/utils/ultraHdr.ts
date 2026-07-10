import { type Canvas, createCanvas, loadImage } from '@napi-rs/canvas';
import {
  encodeGainMap,
  sRGBToLinear,
  writeJpegGainMap,
  type HdrifyImage,
} from 'hdrify';

export interface UltraHdrOptions {
  /** EV stops (exposure value). Must be > 0 and <= 100. */
  flashStops: number;
  /** JPEG quality 1-100, defaults to 94. */
  quality?: number;
}

/**
 * Takes a PNG buffer (with alpha) and encodes it as an Ultra HDR JPEG
 * with an embedded gain map. On HDR displays, opaque content is boosted
 * by 2^flashStops brightness; transparent background stays at SDR level.
 */
export async function encodeUltraHdrJpeg(pngBuffer: Buffer, options: UltraHdrOptions): Promise<Buffer> {
  const { flashStops, quality = 94 } = options;
  const headroom = 2 ** flashStops;

  // Decode PNG to canvas to get raw RGBA pixels
  const img = await loadImage(pngBuffer);
  const { width, height } = img;
  const canvas: Canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, width, height);
  const source = imageData.data;

  // Convert to linear HDR float data with alpha-based boost
  const data = new Float32Array(width * height * 4);
  for (let si = 0, ti = 0; si < source.length; si += 4, ti += 4) {
    const alpha = source[si + 3] / 255;
    // Premultiply against white background
    const sr = (source[si] / 255) * alpha + (1 - alpha);
    const sg = (source[si + 1] / 255) * alpha + (1 - alpha);
    const sb = (source[si + 2] / 255) * alpha + (1 - alpha);
    // Convert sRGB to linear
    const lr = sRGBToLinear(sr);
    const lg = sRGBToLinear(sg);
    const lb = sRGBToLinear(sb);
    // Boost opaque content, leave transparent background at SDR
    const boost = 1 + contentBoostMask(alpha) * (headroom - 1);

    data[ti] = lr * boost;
    data[ti + 1] = lg * boost;
    data[ti + 2] = lb * boost;
    data[ti + 3] = 1;
  }

  const hdrImage: HdrifyImage = {
    width,
    height,
    data,
    linearColorSpace: 'linear-rec709',
  };

  const encoding = encodeGainMap(hdrImage, {
    maxContentBoost: headroom,
    minContentBoost: 1,
    toneMapping: 'neutral',
  });

  const bytes = writeJpegGainMap(encoding, {
    quality,
    format: 'ultrahdr',
  });

  return Buffer.from(bytes);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function contentBoostMask(alpha: number): number {
  return smoothstep(0.08, 0.4, alpha);
}

/**
 * Parse and validate the EV parameter from a request query.
 * Returns a positive number <= 100, or null if invalid/absent.
 */
export function parseEvParam(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  return parsed;
}
