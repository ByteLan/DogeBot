import type { FeishuBot, StyleStickerFeature, StyleStickerCardAction, StyleStickerCardState } from '../../types.js';
import type { StyleStickerOptions } from '../../styleStickers.js';
import { STYLE_STICKER_HDR_EV_MAX, STYLE_STICKER_HDR_EV_DEFAULT, parseEvParam, renderStyleStickerImage } from '../../styleStickers.js';
import { uploadImage, sendImageToChat, replyCard } from '../api.js';
import { hexToRgba } from '../../utils/color.js';
import { styleStickerFeatureName } from '../passive/settings.js';
import { openApiBaseUrl, STYLE_STICKER_FEATURES, passiveInteractionConfig } from '../../config.js';

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
/** 卡片手动选色项；随机配色由生成器负责。 */
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

export function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function styleStickerCardHeaderTemplate(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? 'purple' : 'blue';
}

function styleStickerCardButton(action: StyleStickerCardAction, feature: StyleStickerFeature) {
  const [label, type] = {
    preview: ['预览', 'default'],
    send: ['发送', 'primary_filled'],
    withdraw: ['撤回', 'danger_filled'],
    hdr: ['获取 HDR', 'default']
  }[action];
  return {
    tag: 'button',
    name: `style_sticker_${action}`,
    text: plainText(label),
    type,
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

function styleStickerCardColorStyles(colors: readonly string[]) {
  return Object.fromEntries(
    colors.map((color, index) => [
      `cus-${index}`,
      {
        light_mode: hexToRgba(color),
        dark_mode: hexToRgba(color)
      }
    ])
  );
}

function styleStickerColorSelect(field: 'color1' | 'color2', label: string, value: string, colors: readonly string[]) {
  return {
    tag: 'select_static',
    element_id: `style_sticker_${field}`,
    name: STYLE_STICKER_FORM_FIELDS[field],
    placeholder: plainText(`选择${label}`),
    initial_option: value,
    type: 'default',
    width: 'fill',
    options: colors.map((color, index) => ({
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

function styleStickerColumns<T>(flex_mode: 'bisect' | 'trisect', groups: T[][]) {
  return {
    tag: 'column_set',
    flex_mode,
    horizontal_spacing: '8px',
    columns: groups.map(elements => ({ tag: 'column', width: 'weighted', weight: 1, elements }))
  };
}

export function buildStyleStickerCard(state: StyleStickerCardState) {
  const featureName = styleStickerFeatureName(state.feature);
  const colorOptions = [...new Set([...STYLE_STICKER_CARD_COLOR_OPTIONS, state.color1, state.color2])];
  const hdrEv = parseEvParam(state.hdrEv) ?? STYLE_STICKER_HDR_EV_DEFAULT;
  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: false,
      summary: { content: `${featureName}生图卡片` },
      style: { color: styleStickerCardColorStyles(colorOptions) }
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
              max_length: passiveInteractionConfig().styleStickerMaxCharsLimit
            },
            {
              tag: 'markdown',
              content: '**选择颜色**：先从下拉选常用色；如果填写自定义色值（如 `#ff00aa`），会优先使用自定义色值。'
            },
            styleStickerColumns('trisect', [
              [styleStickerColorSelect('color1', '颜色 1', state.color1, colorOptions), styleStickerCustomColorInput('customColor1', '颜色 1')],
              [styleStickerColorSelect('color2', '颜色 2', state.color2, colorOptions), styleStickerCustomColorInput('customColor2', '颜色 2')]
            ]),
            styleStickerColumns('bisect', [
              [{
                tag: 'input',
                element_id: 'style_sticker_gradient_angle',
                name: STYLE_STICKER_FORM_FIELDS.gradientAngle,
                label: plainText('渐变角度（0-360）'),
                placeholder: plainText('例如 90'),
                default_value: String(state.gradientAngle),
                max_length: 3
              }],
              [{
                tag: 'input',
                element_id: 'style_sticker_hdr_ev',
                name: STYLE_STICKER_FORM_FIELDS.hdrEv,
                label: plainText(`HDR 高亮 EV（大于 0 且不超过 ${STYLE_STICKER_HDR_EV_MAX}）`),
                placeholder: plainText(`支持小数，无效值使用 ${STYLE_STICKER_HDR_EV_DEFAULT}`),
                default_value: String(hdrEv)
              }]
            ]),
            styleStickerColumns('trisect', (['withdraw', 'preview', 'send'] as const).map(action => [styleStickerCardButton(action, state.feature)])),
            {
              tag: 'button',
              text: plainText('🔆 打开 HDR 高亮图'),
              type: 'primary_filled',
              width: 'fill',
              behaviors: [{ type: 'open_url', default_url: buildStyleStickerHdrLink(state, hdrEv) }]
            }
          ]
        }
      ]
    }
  };
}

/** 命令、被动回复和卡片共用同一套渲染与上传流程。 */
export async function uploadStyleStickerImage(bot: FeishuBot, feature: StyleStickerFeature, text: string, options: StyleStickerOptions = {}) {
  const { flavor, command } = STYLE_STICKER_FEATURES[feature];
  const rendered = await renderStyleStickerImage(text, flavor, options);
  const imageKey = await uploadImage(bot, rendered.image, `${command.slice(1)}.${rendered.extension}`);
  return { ...rendered, imageKey };
}

export async function renderStyleStickerCardState(
  bot: FeishuBot,
  feature: StyleStickerFeature,
  text: string,
  options: Pick<StyleStickerOptions, 'color1' | 'color2' | 'gradientAngle'> & { hdrEv?: string } = {}
) {
  const fallbackText = styleStickerFeatureName(feature);
  const renderText = text.trim() || fallbackText;
  const { imageKey, colors, gradientAngle } = await uploadStyleStickerImage(bot, feature, renderText, options);
  return {
    feature,
    text: renderText,
    color1: colors[0],
    color2: colors[1],
    gradientAngle,
    imageKey,
    hdrEv: String(parseEvParam(options.hdrEv) ?? STYLE_STICKER_HDR_EV_DEFAULT)
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
  options: Pick<StyleStickerOptions, 'color1' | 'color2' | 'gradientAngle'> = {}
) {
  const { imageKey } = await uploadStyleStickerImage(bot, feature, text, options);
  await sendImageToChat(bot, chatId, imageKey);
}

export function buildStyleStickerHdrLink(state: StyleStickerCardState, ev: unknown = state.hdrEv): string {
  const endpoint = STYLE_STICKER_FEATURES[state.feature].command.slice(1);
  const params = new URLSearchParams({
    text: state.text,
    color1: state.color1,
    color2: state.color2,
    ga: String(state.gradientAngle),
    ev: String(parseEvParam(ev) ?? STYLE_STICKER_HDR_EV_DEFAULT)
  });
  return `${openApiBaseUrl()}/open-api/v1/${endpoint}?${params.toString()}`;
}

export { STYLE_STICKER_CARD_KIND, STYLE_STICKER_FORM_NAME, STYLE_STICKER_FORM_FIELDS, STYLE_STICKER_CARD_COLOR_OPTIONS };
