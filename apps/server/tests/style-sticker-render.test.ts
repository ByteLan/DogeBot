import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { renderStickerToImage } from '@syru/byted-sticker-generator/node';

// Isolate these checks from deployment-specific visual overrides.
for (const key of Object.keys(process.env)) {
  if (key.startsWith('DOGEBOT_STYLE_STICKER_')) delete process.env[key];
}
const { stickerRenderConfig, parseOptionalRenderNumber } = await import('../src/config.js');
const { renderStyleStickerImage } = await import('../src/styleStickers.js');
const fontPath = (name: string) => fileURLToPath(new URL(`../assets/fonts/${name}`, import.meta.url));
const fontFiles = {
  appleColorEmoji: fontPath('AppleColorEmoji.ttf'),
  appleSymbols: fontPath('AppleSymbols.ttf'),
  notoColorEmoji: fontPath('NotoColorEmoji.ttf'),
  notoSansSymbols2: fontPath('NotoSansSymbols2-Regular.ttf')
};
const options = { color1: '#123268', color2: '#9dacc5', gradientAngle: 0 };

test('visual overrides are optional and distinguish zero from missing/invalid input', () => {
  for (const raw of [undefined, '', ' ', '-1', 'NaN', 'Infinity']) {
    assert.equal(parseOptionalRenderNumber(raw), undefined);
    assert.equal(parseOptionalRenderNumber(raw, true), undefined);
  }
  assert.equal(parseOptionalRenderNumber('0'), undefined);
  assert.equal(parseOptionalRenderNumber('0', true), 0);
  assert.equal(parseOptionalRenderNumber(' 1.25 '), 1.25);
  for (const key of ['lineHeight', 'antialiasScale', 'paddingX', 'paddingY', 'outlineStrokeWidth'] as const) {
    assert.equal(stickerRenderConfig[key], undefined);
  }
  const configured = JSON.parse(execFileSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '-e',
    "const { stickerRenderConfig } = await import('./src/config.ts'); console.log(JSON.stringify(stickerRenderConfig));"
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env,
      DOGEBOT_STYLE_STICKER_LINE_HEIGHT: '1.25',
      DOGEBOT_STYLE_STICKER_ANTIALIAS_SCALE: '2',
      DOGEBOT_STYLE_STICKER_PADDING_X: '0',
      DOGEBOT_STYLE_STICKER_PADDING_Y: '0',
      DOGEBOT_STYLE_STICKER_OUTLINE_STROKE_WIDTH: '0'
    }, encoding: 'utf8'
  }));
  assert.equal(configured.lineHeight, 1.25);
  assert.equal(configured.antialiasScale, 2);
  assert.equal(configured.paddingX, 0);
  assert.equal(configured.paddingY, 0);
  assert.equal(configured.outlineStrokeWidth, 0);
});

test('both flavors inherit generator visuals and explicit scales produce distinct images', async () => {
  for (const flavor of ['snh', 'bs'] as const) {
    const widths: number[] = [];
    for (const scale of [1, 2, 3]) {
      const text = '默认效果\n测试';
      const actual = await renderStyleStickerImage(text, flavor, { ...options, scale });
      const expected = await renderStickerToImage({
        text, flavor, flash: false,
        envelope: { colors: [options.color1, options.color2], gradientAngle: 0 }
      }, { fontFiles, outputScale: scale, maxOutputEdge: 4096 * scale });
      assert.equal(actual.renderScale, scale);
      assert.deepEqual(actual.image, expected.buffer);
      widths.push(actual.image.readUInt32BE(16));
    }
    assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `Distinct widths: ${widths}`);
  }
});

test('default/invalid scales use 2; explicit scales are clamped without multiplication', async () => {
  for (const [scale, expected] of [[undefined, 2], ['', 2], [' ', 2], ['invalid', 2], [Infinity, 2], [0, 1], [4, 3], ['1.5', 1.5]] as const) {
    const result = await renderStyleStickerImage('倍率', 'bs', { ...options, scale });
    assert.equal(result.renderScale, expected);
  }
});

test('explicit visual overrides, including zero padding/stroke, reach the renderer', async () => {
  const previous = { ...stickerRenderConfig };
  Object.assign(stickerRenderConfig, { lineHeight: 1.25, antialiasScale: 2, paddingX: 0, paddingY: 0, outlineStrokeWidth: 0 });
  try {
    for (const flavor of ['snh', 'bs'] as const) {
      const text = '显式覆盖\n测试';
      const actual = await renderStyleStickerImage(text, flavor, options);
      const expected = await renderStickerToImage({
        text, flavor, flash: false, lineHeight: 1.25, antialiasScale: 2,
        padding: { x: 0, y: 0 },
        envelope: { colors: [options.color1, options.color2], gradientAngle: 0, outlineStrokeWidth: 0 }
      }, { fontFiles, outputScale: 2, maxOutputEdge: 8192 });
      assert.deepEqual(actual.image, expected.buffer);
    }
  } finally {
    Object.assign(stickerRenderConfig, previous);
  }
});
