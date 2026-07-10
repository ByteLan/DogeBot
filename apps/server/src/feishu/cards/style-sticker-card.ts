import type { FeishuBot, StyleStickerFeature, StyleStickerCardAction, StyleStickerCardState } from '../../types.js';
import type { StickerFlavor } from '../../styleStickerCore.js';
import { renderStyleStickerImage } from '../../styleStickers.js';
import { uploadImage, sendImageToChat, replyCard } from '../api.js';
import { hexToRgba } from '../../utils/color.js';
import { styleStickerFeatureName } from '../passive/settings.js';
import { openApiBaseUrl } from '../../config.js';

const STYLE_STICKER_CARD_KIND = 'style_sticker_generator';
const STYLE_STICKER_FORM_NAME = 'style_sticker_form';
const STYLE_STICKER_FORM_FIELDS = {
  text: 'text',
  color1: 'color1',
  color2: 'color2',
  customColor1: 'customColor1',
  customColor2: 'customColor2',
  gradientAngle: 'gradientAngle',
  hdrEv: 'hdrEv'
} as const;
const STYLE_STICKER_CARD_COLOR_OPTIONS = [
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

function styleStickerFlavor(feature: StyleStickerFeature): StickerFlavor {
  return feature === 'byte_style' ? 'bs' : 'snh';
}

export function styleStickerCommandName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '/byte-style' : '/scale-new-heights';
}

export function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function styleStickerCardHeaderTemplate(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? 'purple' : 'blue';
}

function styleStickerCardButton(action: StyleStickerCardAction, feature: StyleStickerFeature) {
  const labels: Record<StyleStickerCardAction, string> = {
    preview: '预览',
    send: '发送',
    withdraw: '撤回',
    hdr: '获取 HDR'
  };
  const types: Record<StyleStickerCardAction, string> = {
    preview: 'default',
    send: 'primary_filled',
    withdraw: 'danger_filled',
    hdr: 'default'
  };
  return {
    tag: 'button',
    name: `style_sticker_${action}`,
    text: plainText(labels[action]),
    type: types[action],
    width: 'fill',
    form_action_type: 'submit',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: STYLE_STICKER_CARD_KIND,
          action,
          feature
        }
      }
    ]
  };
}

function styleStickerCardColorStyles() {
  return Object.fromEntries(
    STYLE_STICKER_CARD_COLOR_OPTIONS.map((color, index) => [
      `cus-${index}`,
      {
        light_mode: hexToRgba(color),
        dark_mode: hexToRgba(color)
      }
    ])
  );
}

function styleStickerColorSelect(field: 'color1' | 'color2', label: string, value: string) {
  const initialOption = STYLE_STICKER_CARD_COLOR_OPTIONS.includes(value as (typeof STYLE_STICKER_CARD_COLOR_OPTIONS)[number])
    ? value
    : STYLE_STICKER_CARD_COLOR_OPTIONS[0];
  return {
    tag: 'select_static',
    element_id: `style_sticker_${field}`,
    name: STYLE_STICKER_FORM_FIELDS[field],
    placeholder: plainText(`选择${label}`),
    initial_option: initialOption,
    type: 'default',
    width: 'fill',
    options: STYLE_STICKER_CARD_COLOR_OPTIONS.map((color, index) => ({
      text: plainText(`色值 ${index + 1}：${color}`),
      value: color,
      icon: {
        tag: 'standard_icon',
        token: 'signature_outlined',
        color: `cus-${index}`
      }
    }))
  };
}

function styleStickerCustomColorInput(field: 'customColor1' | 'customColor2', label: string) {
  return {
    tag: 'input',
    element_id: `sticker_${field}`,
    name: STYLE_STICKER_FORM_FIELDS[field],
    label: plainText(`${label}自定义`),
    placeholder: plainText('#RRGGBB，填了会优先生效'),
    max_length: 7
  };
}

export function buildStyleStickerCard(state: StyleStickerCardState) {
  const featureName = styleStickerFeatureName(state.feature);
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: false,
      summary: { content: `${featureName}生图卡片` },
      style: {
        color: styleStickerCardColorStyles()
      }
    },
    header: {
      title: plainText(`${featureName}生成器`),
      template: styleStickerCardHeaderTemplate(state.feature)
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '12px',
      elements: [
        {
          tag: 'img',
          element_id: 'style_sticker_preview',
          img_key: state.imageKey,
          alt: plainText(`${featureName}预览图`),
          mode: 'fit_horizontal',
          preview: true
        },
        {
          tag: 'markdown',
          content: `颜色：\`${state.color1}\` / \`${state.color2}\`，渐变角度：\`${state.gradientAngle}°\``
        },
        {
          tag: 'form',
          element_id: STYLE_STICKER_FORM_NAME,
          name: STYLE_STICKER_FORM_NAME,
          direction: 'vertical',
          vertical_spacing: '10px',
          elements: [
            {
              tag: 'input',
              element_id: 'style_sticker_text',
              name: STYLE_STICKER_FORM_FIELDS.text,
              label: plainText('文案'),
              placeholder: plainText('输入要生成的文案'),
              default_value: state.text,
              input_type: 'multiline_text',
              rows: 2,
              auto_resize: true,
              max_rows: 4,
              required: true,
              max_length: 150
            },
            {
              tag: 'markdown',
              content: '**选择颜色**：先从下拉选常用色；如果填写自定义色值（如 `#ff00aa`），会优先使用自定义色值。'
            },
            {
              tag: 'column_set',
              flex_mode: 'trisect',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [
                    styleStickerColorSelect('color1', '颜色 1', state.color1),
                    styleStickerCustomColorInput('customColor1', '颜色 1')
                  ]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [
                    styleStickerColorSelect('color2', '颜色 2', state.color2),
                    styleStickerCustomColorInput('customColor2', '颜色 2')
                  ]
                }
              ]
            },
            {
              tag: 'column_set',
              flex_mode: 'bisect',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [{
                    tag: 'input',
                    element_id: 'style_sticker_gradient_angle',
                    name: STYLE_STICKER_FORM_FIELDS.gradientAngle,
                    label: plainText('渐变角度（0-360）'),
                    placeholder: plainText('例如 90'),
                    default_value: String(state.gradientAngle),
                    max_length: 3
                  }]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [{
                    tag: 'input',
                    element_id: 'style_sticker_hdr_ev',
                    name: STYLE_STICKER_FORM_FIELDS.hdrEv,
                    label: plainText('HDR 高亮 EV（1-100）'),
                    placeholder: plainText('例如 4'),
                    default_value: state.hdrEv || '4',
                    max_length: 3
                  }]
                }
              ]
            },
            {
              tag: 'column_set',
              flex_mode: 'trisect',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('withdraw', state.feature)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('preview', state.feature)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [styleStickerCardButton('send', state.feature)]
                }
              ]
            },
            {
              tag: 'button',
              text: plainText('🔆 打开 HDR 高亮图'),
              type: 'primary_filled',
              width: 'fill',
              behaviors: [{
                type: 'open_url',
                default_url: state.hdrLink || buildStyleStickerHdrLink(state, Number(state.hdrEv) || 4)
              }]
            }
          ]
        }
      ]
    }
  };
}

export async function renderStyleStickerCardState(
  bot: FeishuBot,
  feature: StyleStickerFeature,
  text: string,
  options: { color1?: unknown; color2?: unknown; gradientAngle?: unknown; hdrEv?: string } = {}
) {
  const fallbackText = styleStickerFeatureName(feature);
  const renderText = text.trim() || fallbackText;
  const { image, colors, gradientAngle } = await renderStyleStickerImage(renderText, styleStickerFlavor(feature), options);
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}-preview.png`);
  return {
    feature,
    text: renderText,
    color1: colors[0],
    color2: colors[1],
    gradientAngle,
    imageKey,
    hdrEv: options.hdrEv || '4'
  };
}

export async function replyStyleStickerGeneratorCard(bot: FeishuBot, messageId: string, feature: StyleStickerFeature) {
  const state = await renderStyleStickerCardState(bot, feature, styleStickerFeatureName(feature));
  await replyCard(bot, messageId, buildStyleStickerCard(state));
}

export async function sendStyleStickerToChat(
  bot: FeishuBot,
  chatId: string,
  feature: StyleStickerFeature,
  text: string,
  options: { color1?: unknown; color2?: unknown; gradientAngle?: unknown } = {}
) {
  const { image } = await renderStyleStickerImage(text, styleStickerFlavor(feature), options);
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}.png`);
  await sendImageToChat(bot, chatId, imageKey);
}

export function buildStyleStickerHdrLink(state: StyleStickerCardState, ev: number): string {
  const endpoint = state.feature === 'byte_style' ? 'byte-style' : 'scale-new-heights';
  const params = new URLSearchParams({
    text: state.text,
    color1: state.color1,
    color2: state.color2,
    ga: String(state.gradientAngle),
    ev: String(ev)
  });
  return `${openApiBaseUrl()}/open-api/v1/${endpoint}?${params.toString()}`;
}

export { STYLE_STICKER_CARD_KIND, STYLE_STICKER_FORM_NAME, STYLE_STICKER_FORM_FIELDS, STYLE_STICKER_CARD_COLOR_OPTIONS };
