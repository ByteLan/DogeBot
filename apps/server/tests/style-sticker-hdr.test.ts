import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Request, Response as ExpressResponse } from 'express';
import type { FeishuBot, StyleStickerCardState } from '../src/types.js';
import { renderByteStyle, renderScaleNewHeights } from '../src/styleStickers.js';

// Card modules import the database; keep all test data away from a running bot.
const previousDataDir = process.env.DOGEBOT_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), 'dogebot-hdr-test-'));
process.env.DOGEBOT_DATA_DIR = dataDir;
const { buildStyleStickerCard, buildStyleStickerHdrLink } = await import('../src/feishu/cards/style-sticker-card.js');
const { handleFeishuCardAction } = await import('../src/feishu/card-action.js');
after(() => {
  if (previousDataDir === undefined) delete process.env.DOGEBOT_DATA_DIR;
  else process.env.DOGEBOT_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const colors = { color1: '#9af665', color2: '#755df6' };

test('HTTP HDR boundaries match the JPEG gain map and invalid values disable HDR', async () => {
  for (const handler of [renderByteStyle, renderScaleNewHeights]) {
    for (const ev of [undefined, '', '0', '-1', '5.01', '100', 'NaN', 'Infinity', '0.25', '4.25', '5']) {
      const headers = new Map<string, string>();
      let image: Buffer | undefined;
      const response = {
        setHeader(name: string, value: string) { headers.set(name, value); },
        send(value: Buffer) { image = value; },
        status(code: number) { assert.fail(`Unexpected HTTP ${code} for EV ${ev}`); }
      } as unknown as ExpressResponse;
      await handler({ query: { text: '测试', ...colors, ga: '0', ev } } as unknown as Request, response);
      assert.ok(image, `Missing image for EV ${ev}`);
      if (ev === '0.25' || ev === '4.25' || ev === '5') {
        assert.equal(headers.get('Content-Type'), 'image/jpeg');
        assert.equal(headers.get('X-HDR-EV'), ev);
        const capacity = image.toString('latin1').match(/hdrgm:HDRCapacityMax="([^"]+)"/)?.[1];
        assert.ok(capacity !== undefined && Math.abs(Number(capacity) - Number(ev)) < 1e-12);
      } else {
        assert.equal(headers.get('Content-Type'), 'image/png');
        assert.equal(headers.has('X-HDR-EV'), false);
        assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      }
    }
  }
});

function cardHdrValues(card: ReturnType<typeof buildStyleStickerCard>) {
  const form = card.body.elements.find((element) => element.tag === 'form')!;
  const columns = form.elements!.find((element) => element.tag === 'column_set' && element.flex_mode === 'bisect')!;
  const input = columns.columns![1].elements[0] as { default_value: string; label: { content: string } };
  const button = form.elements!.find((element) => element.tag === 'button')!;
  const link = new URL(button.behaviors![0].default_url);
  return { input, link };
}

test('cards normalize EV values and keep their displayed value and HDR link consistent', () => {
  for (const feature of ['byte_style', 'scale_new_heights'] as const) {
    for (const [hdrEv, expected] of [['', '4'], ['0', '4'], ['-1', '4'], ['5.01', '4'], ['100', '4'], ['NaN', '4'], ['0.125', '0.125'], ['4.25', '4.25'], ['5', '5']]) {
      const state: StyleStickerCardState = {
        feature, text: '测试', ...colors, gradientAngle: 90, imageKey: 'test-image', hdrEv,
        hdrLink: 'https://example.invalid/stale?ev=100'
      };
      const { input, link } = cardHdrValues(buildStyleStickerCard(state));
      assert.equal(input.default_value, expected);
      assert.equal(link.searchParams.get('ev'), expected);
      assert.match(input.label.content, /大于 0 且不超过 5/);
      assert.equal(new URL(buildStyleStickerHdrLink(state)).searchParams.get('ev'), expected);
      assert.equal(new URL(buildStyleStickerHdrLink(state, 100)).searchParams.get('ev'), '4');
    }
  }
});

test('submitted card EV values are normalized before updating the card', async (context) => {
  const cards: ReturnType<typeof buildStyleStickerCard>[] = [];
  // Every network request is intercepted; this test never sends to Feishu.
  context.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url.endsWith('/tenant_access_token/internal')) {
      return Response.json({ tenant_access_token: 'test-token', expire: 7200 });
    }
    if (url.endsWith('/im/v1/images') && init?.method === 'POST') {
      return Response.json({ data: { image_key: 'test-image' } });
    }
    if (url.endsWith('/im/v1/messages/test-message') && init?.method === 'PATCH') {
      cards.push(JSON.parse(JSON.parse(init.body as string).content));
      return Response.json({ code: 0 });
    }
    assert.fail(`Unexpected network request: ${init?.method} ${url}`);
  });
  const bot = { id: -7, app_id: 'test-app', app_secret: 'test-secret', domain: 'feishu' } as FeishuBot;
  for (const [hdrEv, expected] of [['100', '4'], ['0', '4'], ['', '4'], ['0.125', '0.125'], ['4.25', '4.25'], ['5', '5']]) {
    for (const action of ['preview', 'hdr']) {
      const before = cards.length;
      await handleFeishuCardAction(bot, {
        event: {
          context: { open_message_id: 'test-message', open_chat_id: 'test-chat' },
          action: {
            value: { kind: 'style_sticker_generator', action, feature: 'scale_new_heights' },
            form_value: { text: '测试', ...colors, gradientAngle: '0', hdrEv }
          }
        }
      });
      assert.equal(cards.length, before + 1);
      const { input, link } = cardHdrValues(cards.at(-1)!);
      assert.equal(input.default_value, expected);
      assert.equal(link.searchParams.get('ev'), expected);
    }
  }
});
