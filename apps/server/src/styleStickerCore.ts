import { colord } from 'colord';

export interface StickerShadowControls {
  offsetX: number;
  offsetY: number;
  blur: number;
  color: string;
  opacity: number;
}

export interface StickerEnvelopeControls {
  outlineStrokeWidth: number;
  edgeWidth: number;
  colors: string[];
  gradientAngle: number;
  edgeOpacity: number;
}

export interface StickerPaddingControls {
  x: number;
  y: number;
}

export type StickerFlavor = 'snh' | 'bs';

export const STICKER_FLAVORS: StickerFlavor[] = ['snh', 'bs'];

export interface StickerControls {
  text: string;
  flavor: StickerFlavor;
  icon: string;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  alternatingOffset: number;
  peak: boolean;
  tilt: boolean;
  shadow: StickerShadowControls;
  envelope: StickerEnvelopeControls;
  padding: StickerPaddingControls;
}

export const DEFAULT_STICKER_CONTROLS: StickerControls = {
  text: '高峰不常有',
  flavor: 'snh',
  icon: '',
  fontSize: 220,
  letterSpacing: -8,
  lineHeight: 1.1,
  alternatingOffset: 16,
  peak: true,
  tilt: true,
  shadow: {
    offsetX: 4,
    offsetY: 6,
    blur: 6,
    color: '#1c3e63',
    opacity: 0.4,
  },
  envelope: {
    outlineStrokeWidth: 20,
    edgeWidth: 4,
    colors: ['#76baf4', '#2194f7'],
    gradientAngle: 180,
    edgeOpacity: 0.2,
  },
  padding: {
    x: 8,
    y: 24,
  },
};

export function normalizeStickerControls(value: unknown): StickerControls {
  const input = isRecord(value) ? value : {};
  const shadow = isRecord(input.shadow) ? input.shadow : {};
  const envelope = isRecord(input.envelope) ? input.envelope : {};
  const padding = isRecord(input.padding) ? input.padding : {};

  return {
    text:
      typeof input.text === 'string'
        ? input.text
        : DEFAULT_STICKER_CONTROLS.text,
    flavor:
      input.flavor === 'bs' || input.flavor === 'snh'
        ? input.flavor
        : DEFAULT_STICKER_CONTROLS.flavor,
    icon:
      typeof input.icon === 'string'
        ? input.icon
        : DEFAULT_STICKER_CONTROLS.icon,
    fontSize: clampNumber(input.fontSize, 120, 320, DEFAULT_STICKER_CONTROLS.fontSize),
    letterSpacing: clampNumber(input.letterSpacing, -40, 40, DEFAULT_STICKER_CONTROLS.letterSpacing),
    lineHeight: clampNumber(input.lineHeight, 0.8, 2, DEFAULT_STICKER_CONTROLS.lineHeight),
    alternatingOffset: clampNumber(input.alternatingOffset, 0, 48, DEFAULT_STICKER_CONTROLS.alternatingOffset),
    peak:
      typeof input.peak === 'boolean'
        ? input.peak
        : DEFAULT_STICKER_CONTROLS.peak,
    tilt:
      typeof input.tilt === 'boolean'
        ? input.tilt
        : DEFAULT_STICKER_CONTROLS.tilt,
    shadow: {
      offsetX: clampNumber(shadow.offsetX, -60, 60, DEFAULT_STICKER_CONTROLS.shadow.offsetX),
      offsetY: clampNumber(shadow.offsetY, -60, 60, DEFAULT_STICKER_CONTROLS.shadow.offsetY),
      blur: clampNumber(shadow.blur, 0, 36, DEFAULT_STICKER_CONTROLS.shadow.blur),
      color: normalizeColor(shadow.color, DEFAULT_STICKER_CONTROLS.shadow.color),
      opacity: clampNumber(shadow.opacity, 0, 1, DEFAULT_STICKER_CONTROLS.shadow.opacity),
    },
    envelope: {
      outlineStrokeWidth: clampNumber(
        envelope.outlineStrokeWidth,
        0,
        48,
        DEFAULT_STICKER_CONTROLS.envelope.outlineStrokeWidth
      ),
      edgeWidth: clampNumber(
        envelope.edgeWidth,
        0,
        12,
        DEFAULT_STICKER_CONTROLS.envelope.edgeWidth
      ),
      colors: normalizeColors(envelope.colors, DEFAULT_STICKER_CONTROLS.envelope.colors),
      gradientAngle: clampNumber(
        envelope.gradientAngle,
        0,
        360,
        DEFAULT_STICKER_CONTROLS.envelope.gradientAngle
      ),
      edgeOpacity: clampNumber(
        envelope.edgeOpacity,
        0,
        0.4,
        DEFAULT_STICKER_CONTROLS.envelope.edgeOpacity
      ),
    },
    padding: {
      x: clampNumber(padding.x, 0, 120, DEFAULT_STICKER_CONTROLS.padding.x),
      y: clampNumber(padding.y, 0, 120, DEFAULT_STICKER_CONTROLS.padding.y),
    },
  };
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function normalizeColors(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const colors = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0
  );
  if (colors.length === 0) return fallback;
  return colors.slice(0, 3);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function deriveDepthColor(base: string): string {
  return colord(base).saturate(0.08).darken(0.22).toHex();
}

export function resolveGradientStops(colors: string[]): string[] {
  if (colors.length <= 1) {
    const base = colors[0] ?? '#76baf4';
    return [base, deriveDepthColor(base)];
  }
  return colors;
}

export function darken(color: string, amount: number): string {
  const { r, g, b } = colord(color).toRgb();
  const scale = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel * (1 - amount))));
  return `rgb(${scale(r)}, ${scale(g)}, ${scale(b)})`;
}

export function randomVividColor(
  base: string,
  random: () => number = Math.random,
): string {
  const { h } = colord(base).toHsl();
  const adjacent = random() < 0.5;

  const hue = adjacent ? h + (random() < 0.5 ? -1 : 1) * (15 + random() * 30) : h;
  const saturation = adjacent ? 70 + random() * 25 : 60 + random() * 30;
  const lightness = adjacent ? 58 + random() * 10 : 55 + random() * 12;

  return colord({
    h: ((hue % 360) + 360) % 360,
    s: saturation,
    l: lightness,
  }).toHex();
}

const FONT_STYLE = 'normal';

export interface GlyphTransform {
  scale: [number, number];
  rotationDeg: number;
  skewDeg: [number, number];
}

export interface SharedFontDescriptor {
  family: string;
  weight: string;
  file: string;
  transform: GlyphTransform;
}

export const STICKER_FONT_REGISTRY: Record<StickerFlavor, SharedFontDescriptor> = {
  snh: {
    family: 'DouyinSansBold',
    weight: '900',
    file: 'DouyinSansBold.woff2',
    transform: {
      scale: [1, 1],
      rotationDeg: 0,
      skewDeg: [0, -3.5],
    },
  },
  bs: {
    family: 'YouSheBiaoTiHei',
    weight: 'normal',
    file: 'YouSheBiaoTiHei.ttf',
    transform: {
      scale: [1, 1.12],
      rotationDeg: 2,
      skewDeg: [5, -2.1],
    },
  },
};

export function fontGlyphTransform(flavor: StickerFlavor): GlyphTransform {
  return STICKER_FONT_REGISTRY[flavor].transform;
}

export function fontSpec(flavor: StickerFlavor, fontSize: number): string {
  const { family, weight } = STICKER_FONT_REGISTRY[flavor];
  return `${FONT_STYLE} ${weight} ${fontSize}px "${family}", "PingFang SC", sans-serif`;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GlyphMeasurement {
  advanceWidth: number;
  left: number;
  right: number;
  ascent: number;
  descent: number;
}

export interface GlyphPlacement {
  grapheme: string;
  x: number;
  baselineY: number;
  advanceWidth: number;
  bounds: Bounds;
  skew: boolean;
}

export interface StickerLayout {
  placements: GlyphPlacement[];
  bounds: Bounds;
  letterSpacing: number;
  fontSize: number;
  glyphTransform: GlyphTransform;
}

const IDENTITY_GLYPH_TRANSFORM: GlyphTransform = {
  scale: [1, 1],
  rotationDeg: 0,
  skewDeg: [0, 0],
};

const SPACE_ADVANCE_SCALE = 0.35;

export function splitGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), ({ segment }) => segment);
  }

  return Array.from(text);
}

export function getAlternatingOffset(index: number, amplitude: number): number {
  return index % 2 === 0 ? -amplitude : amplitude;
}

export type GraphemeKind = 'space' | 'cjk' | 'word' | 'other';

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\uff66-\uff9f]/u;
const WORD_PATTERN = /[0-9A-Za-z\u00c0-\u024f'’.+-]/u;
const EMOJI_PATTERN = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u200d\u{FE0F}\u{20E3}]/u;

export function isEmojiGrapheme(grapheme: string): boolean {
  return EMOJI_PATTERN.test(grapheme);
}

export function classifyGrapheme(grapheme: string): GraphemeKind {
  if (/^\s+$/u.test(grapheme)) return 'space';
  if (CJK_PATTERN.test(grapheme)) return 'cjk';
  if (WORD_PATTERN.test(grapheme)) return 'word';
  return 'other';
}

export function measureSkewedGlyphBounds(measurement: GlyphMeasurement, skewDeg: number): Bounds {
  const skewTangent = Math.tan((skewDeg * Math.PI) / 180);
  const corners = [
    { x: -measurement.left, y: -measurement.ascent },
    { x: measurement.right, y: -measurement.ascent },
    { x: -measurement.left, y: measurement.descent },
    { x: measurement.right, y: measurement.descent },
  ];

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const corner of corners) {
    const nextY = corner.y + skewTangent * corner.x;
    minX = Math.min(minX, corner.x);
    minY = Math.min(minY, nextY);
    maxX = Math.max(maxX, corner.x);
    maxY = Math.max(maxY, nextY);
  }

  return { minX, minY, maxX, maxY };
}

export function createStickerLayout(
  text: string,
  options: {
    fontSize: number;
    alternatingOffset: number;
    letterSpacing: number;
    lineHeight?: number;
    glyphTransform?: GlyphTransform;
    measureGlyph: (grapheme: string, fontSize: number) => GlyphMeasurement;
  },
): StickerLayout {
  const glyphTransform = options.glyphTransform ?? IDENTITY_GLYPH_TRANSFORM;
  const verticalSkewDeg = glyphTransform.skewDeg[1];
  const lines = text.split('\n');
  const lineSpacing = options.fontSize * (options.lineHeight ?? 1.1);
  const laidLines = lines.map((line) =>
    layoutLine(line, { ...options, verticalSkewDeg }),
  );

  const lineWidths = laidLines.map((line) =>
    line.bounds ? line.bounds.maxX - line.bounds.minX : 0,
  );
  const maxWidth = lineWidths.reduce((max, width) => Math.max(max, width), 0);
  const commonLeft = laidLines.reduce(
    (left, line) => (line.bounds ? Math.min(left, line.bounds.minX) : left),
    Number.POSITIVE_INFINITY,
  );
  const anchorLeft = Number.isFinite(commonLeft) ? commonLeft : 0;

  const placements: GlyphPlacement[] = [];
  let bounds: Bounds | null = null;

  laidLines.forEach((line, lineIndex) => {
    const offsetY = lineIndex * lineSpacing;
    const shiftX = line.bounds
      ? anchorLeft + (maxWidth - (line.bounds.maxX - line.bounds.minX)) / 2 - line.bounds.minX
      : 0;

    for (const placement of line.placements) {
      const shifted: GlyphPlacement = {
        grapheme: placement.grapheme,
        x: placement.x + shiftX,
        baselineY: placement.baselineY + offsetY,
        advanceWidth: placement.advanceWidth,
        bounds: offsetBounds(placement.bounds, shiftX, offsetY),
        skew: placement.skew,
      };
      placements.push(shifted);
      bounds = bounds ? mergeBounds(bounds, shifted.bounds) : shifted.bounds;
    }
  });

  return {
    placements,
    bounds: bounds ?? emptyBounds(),
    letterSpacing: options.letterSpacing,
    fontSize: options.fontSize,
    glyphTransform,
  };
}

function layoutLine(
  text: string,
  options: {
    fontSize: number;
    verticalSkewDeg: number;
    alternatingOffset: number;
    letterSpacing: number;
    measureGlyph: (grapheme: string, fontSize: number) => GlyphMeasurement;
  },
): { placements: GlyphPlacement[]; bounds: Bounds | null } {
  const graphemes = splitGraphemes(text);
  const letterSpacing = options.letterSpacing;
  const verticalSkewTangent = Math.tan((options.verticalSkewDeg * Math.PI) / 180);

  const placements: GlyphPlacement[] = [];
  let cursorX = 0;
  let bounds: Bounds | null = null;

  let unitIndex = -1;
  let prevKind: GraphemeKind | null = null;
  let unitStartX = 0;

  graphemes.forEach((grapheme) => {
    const kind = classifyGrapheme(grapheme);

    if (kind === 'space') {
      const measurement = options.measureGlyph(grapheme, options.fontSize);
      cursorX += Math.max(0, measurement.advanceWidth * SPACE_ADVANCE_SCALE);
      prevKind = 'space';
      return;
    }

    const continuesWord = kind === 'word' && prevKind === 'word';
    if (!continuesWord) {
      unitIndex += 1;
      unitStartX = cursorX;
    }

    const measurement = options.measureGlyph(grapheme, options.fontSize);
    const canSkew = !isEmojiGrapheme(grapheme);
    const unitOffsetX = cursorX - unitStartX;
    const skewedBounds = measureSkewedGlyphBounds(
      measurement,
      canSkew ? options.verticalSkewDeg : 0,
    );
    const wordTiltY = canSkew ? verticalSkewTangent * unitOffsetX : 0;
    const baselineY = getAlternatingOffset(unitIndex, options.alternatingOffset) + wordTiltY;
    const placementBounds = offsetBounds(skewedBounds, cursorX, baselineY);

    placements.push({
      grapheme,
      x: cursorX,
      baselineY,
      advanceWidth: measurement.advanceWidth,
      bounds: placementBounds,
      skew: canSkew,
    });

    bounds = bounds ? mergeBounds(bounds, placementBounds) : placementBounds;
    cursorX += measurement.advanceWidth + letterSpacing;
    prevKind = kind;
  });

  return { placements, bounds };
}

function mergeBounds(left: Bounds, right: Bounds): Bounds {
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

function offsetBounds(bounds: Bounds, offsetX: number, offsetY: number): Bounds {
  return {
    minX: bounds.minX + offsetX,
    minY: bounds.minY + offsetY,
    maxX: bounds.maxX + offsetX,
    maxY: bounds.maxY + offsetY,
  };
}

function emptyBounds(): Bounds {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };
}
