import type {
  ChatCronTask,
  DouyinClickTextOption,
  FeishuBot,
  HelpCardAction,
  HelpCardPage,
  HelpCommandRow,
  HelpMaxDescriptor,
  HelpRateDescriptor,
  PassiveChatSetting,
  PassiveInteractionConfig,
  StyleStickerChatSetting
} from '../../types.js';
import { db } from '../../db.js';
import { openApiBaseUrl, passiveInteractionConfig } from '../../config.js';
import { replyCard } from '../api.js';
import {
  defaultRateForFeature,
  formatRatePercent,
  getPassiveFeatureSetting,
  getStyleStickerSetting
} from '../passive/settings.js';
import { fallbackMentionCardEnabled } from '../fallback-mentions.js';
import { plainText } from './style-sticker-card.js';
import { cronTaskSummary, listChatCronTasks } from '../cron.js';
import { getDefaultCommand } from '../commands/douyin.js';

const HELP_CARD_KIND = 'help_probability_settings';
const HELP_RATE_FORM_FIELDS = {
  reaction: 'reactionRate',
  repeat: 'repeatRate',
  llmReply: 'llmReplyRate',
  mediaRepeat: 'mediaRepeatRate',
  imageReverse: 'imageReverseImageRate',
  stickerReverse: 'imageReverseStickerRate',
  byteStyle: 'byteStyleRate',
  scaleNewHeights: 'scaleNewHeightsRate'
} as const;
const HELP_MAX_FORM_FIELDS = {
  byteStyle: 'byteStyleMaxChars',
  scaleNewHeights: 'scaleNewHeightsMaxChars'
} as const;
const HELP_DOUYIN_FORM_FIELDS = {
  subscribe: 'douyinSubscribeClickTexts',
  unsubscribe: 'douyinUnsubscribeClickTexts'
} as const;
const HELP_CRON_FORM_FIELDS = {
  cronExpr: 'cronExpr',
  commandText: 'cronCommandText',
  deleteTaskIds: 'cronDeleteTaskIds'
} as const;
const HELP_FALLBACK_MENTION_FORM_FIELDS = {
  enabled: 'fallbackMentionCardEnabled'
} as const;

const HELP_CARD_PAGES: HelpCardPage[] = [
  'home',
  'commands',
  'commands_basic',
  'commands_douyin',
  'commands_settings',
  'api',
  'interaction',
  'style',
  'douyin',
  'douyin_subscribe',
  'douyin_unsubscribe',
  'douyin_unsubscribe_confirm',
  'cron',
  'cron_add',
  'cron_delete',
  'cron_delete_confirm',
  'advanced'
];

const HELP_RATE_DESCRIPTORS: HelpRateDescriptor[] = [
  { kind: 'passive', feature: 'reaction', command: '/reaction', featureName: '贴表情', formField: HELP_RATE_FORM_FIELDS.reaction },
  { kind: 'passive', feature: 'repeat', command: '/repeat', featureName: '文本复读', formField: HELP_RATE_FORM_FIELDS.repeat },
  { kind: 'passive', feature: 'llm_reply', command: '/llm-reply', featureName: '大模型接话', formField: HELP_RATE_FORM_FIELDS.llmReply },
  { kind: 'passive', feature: 'media_repeat', command: '/media-repeat', featureName: '图片/表情包复读', formField: HELP_RATE_FORM_FIELDS.mediaRepeat },
  { kind: 'passive', feature: 'image_reverse', command: '/image-reverse', featureName: '图片镜像反转', formField: HELP_RATE_FORM_FIELDS.imageReverse },
  { kind: 'passive', feature: 'sticker_reverse', command: '/sticker-reverse', featureName: '表情包镜像反转', formField: HELP_RATE_FORM_FIELDS.stickerReverse },
  { kind: 'style', feature: 'byte_style', command: '/byte-style / /字节范', featureName: '字节范随机生图', formField: HELP_RATE_FORM_FIELDS.byteStyle },
  { kind: 'style', feature: 'scale_new_heights', command: '/scale-new-heights / /勇攀高峰', featureName: '勇攀高峰随机生图', formField: HELP_RATE_FORM_FIELDS.scaleNewHeights }
];
const HELP_INTERACTION_DESCRIPTORS = HELP_RATE_DESCRIPTORS.filter((descriptor) => descriptor.kind === 'passive');
const HELP_STYLE_DESCRIPTORS = HELP_RATE_DESCRIPTORS.filter((descriptor) => descriptor.kind === 'style');
const HELP_MAX_DESCRIPTORS: HelpMaxDescriptor[] = [
  { feature: 'byte_style', command: '/byte-style / /字节范', featureName: '字节范最大字符数', formField: HELP_MAX_FORM_FIELDS.byteStyle },
  { feature: 'scale_new_heights', command: '/scale-new-heights / /勇攀高峰', featureName: '勇攀高峰最大字符数', formField: HELP_MAX_FORM_FIELDS.scaleNewHeights }
];

const HELP_COMMAND_ROWS: HelpCommandRow[] = [
  {
    command: '/help',
    params: '无',
    description: '打开帮助中心，按分类查看斜杠命令、可填参数、OpenAPI，并配置当前会话的各项能力。'
  },
  {
    command: '/users',
    params: '@用户...、delete [@用户...]、top @用户、new n',
    description: '记录和查看当前发起人 at 过的用户；支持删除、置顶和只看最新 n 个。'
  },
  {
    command: '/douyin',
    params: '{模拟点击文案} [--count n]',
    description: '随机发送匹配文案的抖音收藏视频；n 必须是大于 0 的整数。'
  },
  {
    command: '/douyin',
    params: '--subscribe {模拟点击文案} / --unsubscribe {模拟点击文案}',
    description: '订阅或取消订阅当前会话的抖音收藏分组新增视频通知。'
  },
  {
    command: '/douyin',
    params: '--delete {aweme_id}',
    description: '软删除指定抖音收藏记录；仅 /set-default 管理员可用，aweme_id 需大于 5 位。'
  },
  {
    command: '/douyin',
    params: '{模拟点击文案} --search {关键词}',
    description: '按标题模糊搜索该分组下的视频；支持多字关键词，返回匹配度最高的结果。'
  },
  {
    command: '/douyin',
    params: '{模拟点击文案} --search-random {关键词}',
    description: '同 --search，但从高分候选池中随机选取结果，每次返回不同。'
  },
  {
    command: '视频无效 / 视频失效',
    params: '关键词触发；从当前消息或引用消息取最后一串大于 10 位的数字作为 aweme_id',
    description: '联网检测抖音视频是否失效；疑似失效时不直接删除，而是私聊 /set-default 管理员发送确认卡片（取消/删除），删除才会标记该 aweme_id 为删除。发送抖音链接的各入口也会自动校验，失效则重抽最多 5 次并私聊上报管理员。'
  },
  {
    command: '/set-default',
    params: '"{兜底指令}"',
    description: '设置当前 bot 的默认兜底指令；首次设置者会成为该命令管理员。'
  },
  {
    command: '/add-cron',
    params: '"*/5 * * * *" "[命令]"、--list、--delete n',
    description: '给当前会话添加定时任务；支持列出当前任务并按序号删除；命令可省略，省略时使用 /set-default 配置。'
  },
  {
    command: '/reverse、/反转',
    params: '也支持直接发送 reverse / 反转 / 翻转 / 镜像 / 对称；优先取当前消息首图，否则取引用消息里的图片或表情包',
    description: '将找到的图片或表情包做一次镜像反转；如果命中话题消息，则直接回复到话题里，否则发送到当前会话。'
  },
  {
    command: '/revert、/撤回',
    params: '必须引用消息，或在 bot 发起的话题里使用',
    description: '撤回 bot 自己发出的消息；普通用户仅限当前会话。'
  },
  {
    command: '/reaction、/repeat、/llm-reply',
    params: '--enable / --disable / --rate n',
    description: '开启或关闭当前会话的贴表情、文本复读、大模型接话等被动能力，并可设置会话概率。'
  },
  {
    command: '/media-repeat、/image-reverse、/sticker-reverse',
    params: '--enable / --disable / --rate n',
    description: '开启或关闭当前会话的图片/表情包复读、图片镜像、表情包镜像能力，并可设置会话概率。'
  },
  {
    command: '/byte-style、/字节范',
    params: '[文案]、--enable、--disable、--rate n、--max n',
    description: '把文案生成"字节范"图片；带文案时，命中话题消息会直接回复到话题里，否则发送到当前会话；不带参数时，普通消息会优先尝试用引用消息文字生图，话题里则直接发交互卡片；开关、rate 和 --max 控制随机生图。'
  },
  {
    command: '/scale-new-heights、/勇攀高峰',
    params: '[文案]、--enable、--disable、--rate n、--max n',
    description: '把文案生成"勇攀高峰"图片；带文案时，命中话题消息会直接回复到话题里，否则发送到当前会话；不带参数时，普通消息会优先尝试用引用消息文字生图，话题里则直接发交互卡片；开关、rate 和 --max 控制随机生图。'
  }
];

const BASIC_COMMAND_ROWS = [HELP_COMMAND_ROWS[0], HELP_COMMAND_ROWS[1], HELP_COMMAND_ROWS[10], HELP_COMMAND_ROWS[11]];
const DOUYIN_COMMAND_ROWS = HELP_COMMAND_ROWS.slice(2, 8);
const SETTINGS_COMMAND_ROWS = [HELP_COMMAND_ROWS[8], HELP_COMMAND_ROWS[9], ...HELP_COMMAND_ROWS.slice(12, 16)];

type HelpCardBuildOptions = {
  page?: HelpCardPage;
  notice?: string;
  selectedValues?: string[];
};

type HelpButtonOptions = {
  text: string;
  action: HelpCardAction;
  page?: HelpCardPage;
  selectedValues?: string[];
  type?: 'default' | 'primary_filled' | 'danger_filled';
  formSubmit?: boolean;
  disabled?: boolean;
};

export function isHelpCardPage(value: unknown): value is HelpCardPage {
  return typeof value === 'string' && HELP_CARD_PAGES.includes(value as HelpCardPage);
}

export function helpRateSettingSummary(
  botId: number,
  chatId: string,
  descriptor: HelpRateDescriptor,
  config: PassiveInteractionConfig
) {
  const defaultRate = defaultRateForFeature(config, descriptor.feature);
  return descriptor.kind === 'passive'
    ? getPassiveFeatureSetting(botId, chatId, descriptor.feature, defaultRate)
    : getStyleStickerSetting(
      botId,
      chatId,
      descriptor.feature,
      defaultRate,
      config.styleStickerDefaultMaxChars,
      config.styleStickerMaxCharsLimit
    );
}

export function recentUnsubscribedDouyinClickTexts(bot: FeishuBot, chatId: string, limit = 10) {
  if (!chatId || !bot.user_id) return [] as DouyinClickTextOption[];
  return db.prepare(`
    SELECT r.click_text AS clickText, MAX(r.updated_at) AS updatedAt
    FROM douyin_aweme_records r
    LEFT JOIN feishu_douyin_subscriptions s
      ON s.bot_id = ? AND s.chat_id = ? AND s.click_text = r.click_text
    WHERE r.user_id = ?
      AND COALESCE(r.status, '') <> 'delete'
      AND s.id IS NULL
    GROUP BY r.click_text
    ORDER BY updatedAt DESC, r.click_text ASC
    LIMIT ?
  `).all(bot.id, chatId, bot.user_id, limit) as DouyinClickTextOption[];
}

export function currentChatDouyinSubscriptionsWithRecentUpdates(bot: FeishuBot, chatId: string, limit = 10) {
  if (!chatId || !bot.user_id) return [] as DouyinClickTextOption[];
  return db.prepare(`
    SELECT s.click_text AS clickText, COALESCE(MAX(r.updated_at), s.updated_at) AS updatedAt
    FROM feishu_douyin_subscriptions s
    LEFT JOIN douyin_aweme_records r
      ON r.user_id = ?
      AND r.click_text = s.click_text
      AND COALESCE(r.status, '') <> 'delete'
    WHERE s.bot_id = ? AND s.chat_id = ?
    GROUP BY s.id, s.click_text, s.updated_at
    ORDER BY updatedAt ASC, s.click_text ASC
    LIMIT ?
  `).all(bot.user_id, bot.id, chatId, limit) as DouyinClickTextOption[];
}

function currentChatDouyinSubscriptionCount(botId: number, chatId: string) {
  if (!chatId) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM feishu_douyin_subscriptions
    WHERE bot_id = ? AND chat_id = ?
  `).get(botId, chatId) as { count: number } | undefined;
  return Number(row?.count || 0);
}

export function formatEditableRateValue(rate: number) {
  return rate.toFixed(4).replace(/\.?0+$/, '');
}

export function formatDateTimeText(value: string) {
  return value.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function helpRateEnabledField(descriptor: HelpRateDescriptor) {
  return `${descriptor.formField}Enabled`;
}

function helpRateEnabledSelect(descriptor: HelpRateDescriptor, setting: PassiveChatSetting | StyleStickerChatSetting) {
  return {
    tag: 'select_static',
    name: helpRateEnabledField(descriptor),
    placeholder: plainText('选择状态'),
    initial_option: setting.enabled ? 'enabled' : 'disabled',
    type: 'default',
    width: 'fill',
    options: [
      { text: plainText('开启'), value: 'enabled' },
      { text: plainText('关闭'), value: 'disabled' }
    ]
  };
}

function helpFallbackMentionEnabledSelect(enabled: boolean) {
  return {
    tag: 'select_static',
    name: HELP_FALLBACK_MENTION_FORM_FIELDS.enabled,
    initial_option: enabled ? 'enabled' : 'disabled',
    type: 'default',
    width: 'fill',
    required: true,
    options: [
      { text: plainText('开启'), value: 'enabled' },
      { text: plainText('关闭'), value: 'disabled' }
    ]
  };
}

function helpRateInput(descriptor: HelpRateDescriptor, setting: PassiveChatSetting | StyleStickerChatSetting) {
  return {
    tag: 'input',
    name: descriptor.formField,
    placeholder: plainText('支持 0.05 或 5'),
    default_value: formatEditableRateValue(setting.rate),
    max_length: 8
  };
}

function helpMaxInput(descriptor: HelpMaxDescriptor, maxChars: number) {
  return {
    tag: 'input',
    name: descriptor.formField,
    placeholder: plainText('最大字符数'),
    default_value: String(maxChars),
    max_length: 4
  };
}

function helpRateFormHeader() {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [{ tag: 'markdown', content: '**配置项**' }]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [{ tag: 'markdown', content: '**状态**' }]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [{ tag: 'markdown', content: '**概率**' }]
      }
    ]
  };
}

function helpRateItem(descriptor: HelpRateDescriptor, setting: PassiveChatSetting | StyleStickerChatSetting) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [
          {
            tag: 'markdown',
            content: `**${descriptor.featureName}**\n\`${descriptor.command}\`\n当前 ${setting.enabled ? '开启' : '关闭'} / ${formatRatePercent(setting.rate)}${setting.hasCustomRate ? '（会话配置）' : '（继承全局）'}\n全局默认 ${formatRatePercent(setting.defaultRate)}；上限 ${formatRatePercent(setting.maxRate)}${setting.isRateCapped ? '（历史值已按上限收敛）' : ''}`
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [helpRateEnabledSelect(descriptor, setting)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [helpRateInput(descriptor, setting)]
      }
    ]
  };
}

function helpStyleItem(
  descriptor: HelpRateDescriptor,
  maxDescriptor: HelpMaxDescriptor,
  setting: StyleStickerChatSetting,
  maxLimit: number
) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [
          {
            tag: 'markdown',
            content: `**${descriptor.featureName}**\n\`${descriptor.command}\`\n当前 ${setting.enabled ? '开启' : '关闭'} / ${formatRatePercent(setting.rate)}${setting.hasCustomRate ? '（会话配置）' : '（继承全局）'}\n概率上限 ${formatRatePercent(setting.maxRate)}；字符当前 ${setting.maxChars}${setting.hasCustomMax ? '（会话配置）' : '（默认）'}，上限 ${maxLimit}`
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        elements: [helpRateEnabledSelect(descriptor, setting)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        elements: [helpRateInput(descriptor, setting)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 2,
        elements: [helpMaxInput(maxDescriptor, setting.maxChars)]
      }
    ]
  };
}

function helpDouyinMultiSelect(field: string, placeholderText: string, options: DouyinClickTextOption[], emptyText: string) {
  return {
    tag: 'multi_select_static',
    name: field,
    type: 'default',
    width: 'fill',
    required: false,
    disabled: options.length === 0,
    placeholder: plainText(options.length > 0 ? placeholderText : emptyText),
    selected_values: [],
    options: options.map((option) => ({
      text: plainText(`${option.clickText}（${formatDateTimeText(option.updatedAt)}）`),
      value: option.clickText
    }))
  };
}

function helpCronExprInput() {
  return {
    tag: 'input',
    name: HELP_CRON_FORM_FIELDS.cronExpr,
    placeholder: plainText('cron 表达式，例如 */5 * * * *'),
    max_length: 64
  };
}

function helpCronCommandTextInput(defaultCommand: string) {
  return {
    tag: 'input',
    name: HELP_CRON_FORM_FIELDS.commandText,
    placeholder: plainText(defaultCommand ? `命令文本；留空使用默认：${defaultCommand}` : '命令文本，例如 /douyin 随机甜妹 --count 1'),
    max_length: 500
  };
}

function helpCronDeleteMultiSelect(tasks: ChatCronTask[]) {
  return {
    tag: 'multi_select_static',
    name: HELP_CRON_FORM_FIELDS.deleteTaskIds,
    type: 'default',
    width: 'fill',
    required: false,
    disabled: tasks.length === 0,
    placeholder: plainText(tasks.length > 0 ? '选择要删除的定时任务' : '当前会话暂无可删除的定时任务'),
    selected_values: [],
    options: tasks.map((task, index) => ({
      text: plainText(`${index + 1}. ${task.cron_expr} -> ${task.command_text}`),
      value: String(task.id)
    }))
  };
}

function helpCardButton(options: HelpButtonOptions) {
  return {
    tag: 'button',
    name: `help_${options.action}_${options.page || 'legacy'}`,
    text: plainText(options.text),
    type: options.type || 'default',
    width: 'fill',
    disabled: options.disabled || false,
    ...(options.formSubmit ? { form_action_type: 'submit' } : {}),
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: HELP_CARD_KIND,
          action: options.action,
          ...(options.page ? { page: options.page } : {}),
          ...(options.selectedValues ? { selectedValues: options.selectedValues } : {})
        }
      }
    ]
  };
}

function navigationButton(text: string, page: HelpCardPage) {
  return helpCardButton({ text, action: 'navigate', page });
}

function buttonRows(buttons: object[]) {
  const rows: object[] = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: buttons.slice(index, index + 2).map((button) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [button]
      }))
    });
  }
  return rows;
}

function formFooter(page: HelpCardPage, backPage: HelpCardPage, submitText: string, destructive = false) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [navigationButton('返回', backPage)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [helpCardButton({
          text: submitText,
          action: 'submit',
          page,
          type: destructive ? 'danger_filled' : 'primary_filled',
          formSubmit: true
        })]
      }
    ]
  };
}

function simpleBackFooter(backPage: HelpCardPage) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    columns: [
      {
        tag: 'column',
        width: 'stretch',
        elements: [navigationButton('返回', backPage)]
      }
    ]
  };
}

function helpForm(page: HelpCardPage, elements: object[]) {
  return {
    tag: 'form',
    name: `help_form_${page}`,
    direction: 'vertical',
    vertical_spacing: '10px',
    elements
  };
}

function noticeElements(notice?: string) {
  if (!notice) return [] as object[];
  return [
    { tag: 'markdown', content: notice },
    { tag: 'hr' }
  ];
}

function helpHomeSummaryMarkdown(bot: FeishuBot, chatId: string) {
  const config = passiveInteractionConfig();
  const interactionEnabled = HELP_INTERACTION_DESCRIPTORS.filter((descriptor) => (
    helpRateSettingSummary(bot.id, chatId, descriptor, config).enabled
  )).length;
  const styleEnabled = HELP_STYLE_DESCRIPTORS.filter((descriptor) => (
    helpRateSettingSummary(bot.id, chatId, descriptor, config).enabled
  )).length;
  const subscriptionCount = currentChatDouyinSubscriptionCount(bot.id, chatId);
  const cronCount = listChatCronTasks(bot.id, chatId).length;
  return [
    '**当前会话概览**',
    `- 智能互动：\`${interactionEnabled}/${HELP_INTERACTION_DESCRIPTORS.length}\` 项已开启`,
    `- 随机生图：\`${styleEnabled}/${HELP_STYLE_DESCRIPTORS.length}\` 项已开启`,
    `- 抖音订阅：\`${subscriptionCount}\` 个`,
    `- 定时任务：\`${cronCount}\` 个`,
    `- 兜底 @ 人员收集：\`${fallbackMentionCardEnabled(bot.id, chatId) ? '开启' : '关闭'}\``
  ].join('\n');
}

export function helpReadonlySummaryMarkdown(bot: FeishuBot, chatId: string) {
  return helpHomeSummaryMarkdown(bot, chatId);
}

function homePageElements(bot: FeishuBot, chatId: string, notice?: string) {
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: [
        '群聊里需要先 @ 机器人，单聊里可以直接发送命令。帮助内容与会话配置已分开，所有群成员都可以查看和修改当前会话配置。',
        '',
        helpHomeSummaryMarkdown(bot, chatId)
      ].join('\n')
    },
    { tag: 'hr' },
    { tag: 'markdown', content: '**使用帮助**\n按分类查看命令用法，或查看可直接调用的 OpenAPI。' },
    ...buttonRows([
      navigationButton('命令帮助', 'commands'),
      navigationButton('开发者 OpenAPI', 'api')
    ]),
    { tag: 'hr' },
    { tag: 'markdown', content: '**当前会话配置**\n每个页面独立保存，不会连带修改其他模块。' },
    ...buttonRows([
      navigationButton('智能互动', 'interaction'),
      navigationButton('图片生成', 'style'),
      navigationButton('抖音订阅', 'douyin'),
      navigationButton('定时任务', 'cron'),
      navigationButton('高级设置', 'advanced')
    ]),
    { tag: 'hr' },
    {
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'stretch',
          elements: [helpCardButton({ text: '撤回卡片', action: 'withdraw', type: 'danger_filled' })]
        }
      ]
    }
  ];
}

function commandRowsMarkdown(title: string, rows: HelpCommandRow[]) {
  return [
    `**${title}**`,
    ...rows.flatMap((row) => [
      '',
      `**\`${row.command}\`**`,
      `参数：${row.params}`,
      row.description
    ])
  ].join('\n');
}

function commandHubElements() {
  return [
    {
      tag: 'markdown',
      content: '**命令帮助**\n每组最多展示 6 项，选择你要查看的命令类型。'
    },
    ...buttonRows([
      navigationButton('基础与媒体命令', 'commands_basic'),
      navigationButton('抖音命令', 'commands_douyin'),
      navigationButton('配置与自动化命令', 'commands_settings')
    ]),
    { tag: 'hr' },
    simpleBackFooter('home')
  ];
}

function commandPageElements(title: string, rows: HelpCommandRow[]) {
  return [
    { tag: 'markdown', content: commandRowsMarkdown(title, rows) },
    { tag: 'hr' },
    simpleBackFooter('commands')
  ];
}

function openApiHelpMarkdown() {
  const base = openApiBaseUrl();
  return [
    '**开发者 OpenAPI**',
    '',
    `**随机抖音 JSON**\n\`${base}/open-api/v1/mm\`\n无参数；返回 JSON \`{ data: { url } }\`。`,
    '',
    `**随机抖音跳转**\n\`${base}/open-api/v1/mm/redirect\`\n无参数；302 重定向到随机抖音视频地址。`,
    '',
    `**字节范生图**\n\`${base}/open-api/v1/byte-style?text=xxx\`\n\`text\` 必填；\`color1\` / \`color2\` 可选，支持 \`#RRGGBB\`；\`scale\` 可选；\`gradientAngle\` 或 \`ga\` 可选，范围 \`0-360\`；返回 \`image/png\`。`,
    '',
    `**勇攀高峰生图**\n\`${base}/open-api/v1/scale-new-heights?text=xxx\`\n参数同字节范接口（\`text\` 必填，\`color1\`/\`color2\`/\`scale\`/\`gradientAngle\` 或 \`ga\` 可选）；返回 \`image/png\`。`
  ].join('\n');
}

function interactionPageElements(bot: FeishuBot, chatId: string, notice?: string) {
  const config = passiveInteractionConfig();
  const items = HELP_INTERACTION_DESCRIPTORS.flatMap((descriptor, index) => {
    const setting = helpRateSettingSummary(bot.id, chatId, descriptor, config);
    return [
      helpRateItem(descriptor, setting),
      ...(index < HELP_INTERACTION_DESCRIPTORS.length - 1 ? [{ tag: 'hr' }] : [])
    ];
  });
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**智能互动**\n配置 6 项被动互动能力。概率支持填写 `0.05` 或 `5` 表示 5%，超出单项上限时会按上限保存。'
    },
    helpForm('interaction', [
      helpRateFormHeader(),
      { tag: 'hr' },
      ...items,
      { tag: 'hr' },
      formFooter('interaction', 'home', '保存智能互动')
    ])
  ];
}

function stylePageElements(bot: FeishuBot, chatId: string, notice?: string) {
  const config = passiveInteractionConfig();
  const items = HELP_STYLE_DESCRIPTORS.flatMap((descriptor, index) => {
    const setting = helpRateSettingSummary(bot.id, chatId, descriptor, config) as StyleStickerChatSetting;
    const maxDescriptor = HELP_MAX_DESCRIPTORS.find((item) => item.feature === descriptor.feature);
    if (!maxDescriptor) return [];
    return [
      helpStyleItem(descriptor, maxDescriptor, setting, config.styleStickerMaxCharsLimit),
      ...(index < HELP_STYLE_DESCRIPTORS.length - 1 ? [{ tag: 'hr' }] : [])
    ];
  });
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**图片生成**\n分别设置两种随机生图能力的状态、触发概率和最大字符数。'
    },
    helpForm('style', [
      ...items,
      { tag: 'hr' },
      formFooter('style', 'home', '保存图片生成')
    ])
  ];
}

function douyinSummaryMarkdown(bot: FeishuBot, chatId: string) {
  const count = currentChatDouyinSubscriptionCount(bot.id, chatId);
  const subscriptions = currentChatDouyinSubscriptionsWithRecentUpdates(bot, chatId, 6);
  return [
    `**当前订阅：${count} 个**`,
    subscriptions.length > 0
      ? subscriptions.map((item) => `- \`${item.clickText}\`（${formatDateTimeText(item.updatedAt)}）`).join('\n')
      : '- 当前会话暂无订阅',
    ...(count > subscriptions.length ? [`- 另有 ${count - subscriptions.length} 个未在此处展开`] : [])
  ].join('\n');
}

function douyinHubElements(bot: FeishuBot, chatId: string, notice?: string) {
  return [
    ...noticeElements(notice),
    { tag: 'markdown', content: douyinSummaryMarkdown(bot, chatId) },
    { tag: 'hr' },
    ...buttonRows([
      navigationButton('新增订阅', 'douyin_subscribe'),
      navigationButton('取消订阅', 'douyin_unsubscribe')
    ]),
    simpleBackFooter('home')
  ];
}

function douyinSubscribeElements(bot: FeishuBot, chatId: string, notice?: string) {
  const options = recentUnsubscribedDouyinClickTexts(bot, chatId);
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**新增抖音订阅**\n展示最近更新、但当前会话尚未订阅的模拟点击文案。'
    },
    helpForm('douyin_subscribe', [
      helpDouyinMultiSelect(
        HELP_DOUYIN_FORM_FIELDS.subscribe,
        '选择要新增的订阅',
        options,
        '暂无可新增订阅项'
      ),
      formFooter('douyin_subscribe', 'douyin', '确认新增')
    ])
  ];
}

function douyinUnsubscribeElements(bot: FeishuBot, chatId: string, notice?: string) {
  const options = currentChatDouyinSubscriptionsWithRecentUpdates(bot, chatId);
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**取消抖音订阅**\n选择订阅后进入独立确认页；当前页面不会直接取消。'
    },
    helpForm('douyin_unsubscribe', [
      helpDouyinMultiSelect(
        HELP_DOUYIN_FORM_FIELDS.unsubscribe,
        '选择要取消的订阅',
        options,
        '当前会话暂无可取消的订阅'
      ),
      formFooter('douyin_unsubscribe', 'douyin', '下一步')
    ])
  ];
}

function confirmFooter(
  page: HelpCardPage,
  backPage: HelpCardPage,
  selectedValues: string[],
  text: string
) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [navigationButton('返回', backPage)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [helpCardButton({
          text,
          action: 'confirm',
          page,
          selectedValues,
          type: 'danger_filled',
          disabled: selectedValues.length === 0
        })]
      }
    ]
  };
}

function douyinUnsubscribeConfirmElements(selectedValues: string[]) {
  return [
    {
      tag: 'markdown',
      content: [
        '**确认取消以下抖音订阅？**',
        '',
        ...(selectedValues.length > 0
          ? selectedValues.map((value) => `- \`${value}\``)
          : ['没有待取消的订阅，请返回重新选择。']),
        '',
        '取消后，当前会话将不再收到这些分组的新增视频通知。'
      ].join('\n')
    },
    { tag: 'hr' },
    confirmFooter('douyin_unsubscribe_confirm', 'douyin_unsubscribe', selectedValues, '确认取消订阅')
  ];
}

function cronSummaryMarkdown(botId: number, chatId: string) {
  const tasks = listChatCronTasks(botId, chatId);
  const visibleTasks = tasks.slice(0, 6);
  return [
    `**当前定时任务：${tasks.length} 个**`,
    visibleTasks.length > 0
      ? visibleTasks.map((task, index) => `- ${cronTaskSummary(task, index)}`).join('\n')
      : '- 当前会话暂无定时任务',
    ...(tasks.length > visibleTasks.length ? [`- 另有 ${tasks.length - visibleTasks.length} 个未在此处展开`] : [])
  ].join('\n');
}

function cronHubElements(bot: FeishuBot, chatId: string, notice?: string) {
  return [
    ...noticeElements(notice),
    { tag: 'markdown', content: cronSummaryMarkdown(bot.id, chatId) },
    { tag: 'hr' },
    ...buttonRows([
      navigationButton('新增定时任务', 'cron_add'),
      navigationButton('删除定时任务', 'cron_delete')
    ]),
    simpleBackFooter('home')
  ];
}

function cronAddElements(bot: FeishuBot, notice?: string) {
  const defaultCommand = getDefaultCommand(bot.id);
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**新增定时任务**\n填写 cron 表达式和命令。命令留空时使用当前 bot 的默认兜底指令。'
    },
    helpForm('cron_add', [
      helpCronExprInput(),
      helpCronCommandTextInput(defaultCommand),
      formFooter('cron_add', 'cron', '新增任务')
    ])
  ];
}

function cronDeleteElements(bot: FeishuBot, chatId: string, notice?: string) {
  const tasks = listChatCronTasks(bot.id, chatId);
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**删除定时任务**\n选择任务后进入独立确认页；当前页面不会直接删除。'
    },
    helpForm('cron_delete', [
      helpCronDeleteMultiSelect(tasks),
      formFooter('cron_delete', 'cron', '下一步')
    ])
  ];
}

function cronDeleteConfirmElements(bot: FeishuBot, chatId: string, selectedValues: string[]) {
  const selectedSet = new Set(selectedValues);
  const tasks = listChatCronTasks(bot.id, chatId).filter((task) => selectedSet.has(String(task.id)));
  const validIds = tasks.map((task) => String(task.id));
  return [
    {
      tag: 'markdown',
      content: [
        '**确认删除以下定时任务？**',
        '',
        ...(tasks.length > 0
          ? tasks.map((task) => `- \`${task.cron_expr} -> ${task.command_text}\``)
          : ['没有待删除的任务，请返回重新选择。']),
        '',
        '删除后任务将停止执行，此操作不会影响已经发送的消息。'
      ].join('\n')
    },
    { tag: 'hr' },
    confirmFooter('cron_delete_confirm', 'cron_delete', validIds, '确认删除任务')
  ];
}

function advancedPageElements(bot: FeishuBot, chatId: string, notice?: string) {
  return [
    ...noticeElements(notice),
    {
      tag: 'markdown',
      content: '**高级设置**\n未命中 `/users` 且执行兜底指令时，是否弹出 @ 人员选择卡片。'
    },
    helpForm('advanced', [
      helpFallbackMentionEnabledSelect(fallbackMentionCardEnabled(bot.id, chatId)),
      formFooter('advanced', 'home', '保存高级设置')
    ])
  ];
}

function helpPageTitle(page: HelpCardPage) {
  const titles: Record<HelpCardPage, string> = {
    home: 'DogeBot 帮助中心',
    commands: '命令帮助',
    commands_basic: '基础与媒体命令',
    commands_douyin: '抖音命令',
    commands_settings: '配置与自动化命令',
    api: '开发者 OpenAPI',
    interaction: '智能互动配置',
    style: '图片生成配置',
    douyin: '抖音订阅管理',
    douyin_subscribe: '新增抖音订阅',
    douyin_unsubscribe: '取消抖音订阅',
    douyin_unsubscribe_confirm: '确认取消订阅',
    cron: '定时任务管理',
    cron_add: '新增定时任务',
    cron_delete: '删除定时任务',
    cron_delete_confirm: '确认删除任务',
    advanced: '高级设置'
  };
  return titles[page];
}

function helpPageElements(bot: FeishuBot, chatId: string, options: Required<HelpCardBuildOptions>) {
  switch (options.page) {
    case 'commands':
      return commandHubElements();
    case 'commands_basic':
      return commandPageElements('基础与媒体命令', BASIC_COMMAND_ROWS);
    case 'commands_douyin':
      return commandPageElements('抖音命令', DOUYIN_COMMAND_ROWS);
    case 'commands_settings':
      return commandPageElements('配置与自动化命令', SETTINGS_COMMAND_ROWS);
    case 'api':
      return [
        { tag: 'markdown', content: openApiHelpMarkdown() },
        { tag: 'hr' },
        simpleBackFooter('home')
      ];
    case 'interaction':
      return interactionPageElements(bot, chatId, options.notice);
    case 'style':
      return stylePageElements(bot, chatId, options.notice);
    case 'douyin':
      return douyinHubElements(bot, chatId, options.notice);
    case 'douyin_subscribe':
      return douyinSubscribeElements(bot, chatId, options.notice);
    case 'douyin_unsubscribe':
      return douyinUnsubscribeElements(bot, chatId, options.notice);
    case 'douyin_unsubscribe_confirm':
      return douyinUnsubscribeConfirmElements(options.selectedValues);
    case 'cron':
      return cronHubElements(bot, chatId, options.notice);
    case 'cron_add':
      return cronAddElements(bot, options.notice);
    case 'cron_delete':
      return cronDeleteElements(bot, chatId, options.notice);
    case 'cron_delete_confirm':
      return cronDeleteConfirmElements(bot, chatId, options.selectedValues);
    case 'advanced':
      return advancedPageElements(bot, chatId, options.notice);
    case 'home':
    default:
      return homePageElements(bot, chatId, options.notice);
  }
}

export function buildHelpCard(bot: FeishuBot, chatId: string, options: HelpCardBuildOptions = {}) {
  const normalizedOptions: Required<HelpCardBuildOptions> = {
    page: options.page || 'home',
    notice: options.notice || '',
    selectedValues: options.selectedValues || []
  };
  const confirmPage = normalizedOptions.page === 'douyin_unsubscribe_confirm' || normalizedOptions.page === 'cron_delete_confirm';
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      summary: { content: helpPageTitle(normalizedOptions.page) }
    },
    header: {
      title: plainText(helpPageTitle(normalizedOptions.page)),
      template: confirmPage ? 'red' : 'blue'
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements: helpPageElements(bot, chatId, normalizedOptions)
    }
  };
}

export async function replyHelpCard(bot: FeishuBot, messageId: string, chatId: string) {
  await replyCard(bot, messageId, buildHelpCard(bot, chatId));
}

export {
  HELP_CARD_KIND,
  HELP_CARD_PAGES,
  HELP_RATE_FORM_FIELDS,
  HELP_MAX_FORM_FIELDS,
  HELP_DOUYIN_FORM_FIELDS,
  HELP_CRON_FORM_FIELDS,
  HELP_FALLBACK_MENTION_FORM_FIELDS,
  HELP_RATE_DESCRIPTORS,
  HELP_INTERACTION_DESCRIPTORS,
  HELP_STYLE_DESCRIPTORS,
  HELP_MAX_DESCRIPTORS,
  HELP_COMMAND_ROWS
};
