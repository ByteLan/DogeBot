import type { FeishuBot, HelpCommandRow, HelpRateDescriptor, HelpMaxDescriptor, HelpCardAction, ChatCronTask, DouyinClickTextOption, PassiveChatSetting, StyleStickerChatSetting, PassiveInteractionConfig } from '../../types.js';
import { db } from '../../db.js';
import { passiveInteractionConfig, openApiBaseUrl } from '../../config.js';
import { replyCard } from '../api.js';
import { getPassiveFeatureSetting, getStyleStickerSetting, defaultRateForFeature, formatRatePercent } from '../passive/settings.js';
import { fallbackMentionCardEnabled } from '../fallback-mentions.js';
import { plainText } from './style-sticker-card.js';
import { listChatCronTasks, cronTaskSummary } from '../cron.js';
import { getDefaultCommand } from '../commands/douyin.js';

const HELP_CARD_KIND = 'help_probability_settings';
const HELP_RATE_FORM_NAME = 'help_probability_form';
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

const HELP_RATE_DESCRIPTORS: HelpRateDescriptor[] = [
  { kind: 'passive', feature: 'reaction', command: '/reaction', featureName: '贴表情', formField: HELP_RATE_FORM_FIELDS.reaction },
  { kind: 'passive', feature: 'repeat', command: '/repeat', featureName: '文本复读', formField: HELP_RATE_FORM_FIELDS.repeat },
  { kind: 'passive', feature: 'llm_reply', command: '/llm-reply', featureName: '大模型接话', formField: HELP_RATE_FORM_FIELDS.llmReply },
  { kind: 'passive', feature: 'media_repeat', command: '/media-repeat', featureName: '图片/表情包复读', formField: HELP_RATE_FORM_FIELDS.mediaRepeat },
  { kind: 'passive', feature: 'image_reverse', command: '/image-reverse', featureName: '图片镜像反转', formField: HELP_RATE_FORM_FIELDS.imageReverse },
  { kind: 'passive', feature: 'sticker_reverse', command: '/sticker-reverse', featureName: '表情包镜像反转', formField: HELP_RATE_FORM_FIELDS.stickerReverse },
  { kind: 'style', feature: 'byte_style', command: '/byte-style / /字节范', featureName: '字节范随机生图', formField: HELP_RATE_FORM_FIELDS.byteStyle },
  { kind: 'style', feature: 'scale_new_heights', command: '/scale-new-heights / /勇攀高峰', featureName: '勇攀高峰随机生图', formField: HELP_RATE_FORM_FIELDS.scaleNewHeights }
] as const;
const HELP_MAX_DESCRIPTORS: HelpMaxDescriptor[] = [
  { feature: 'byte_style', command: '/byte-style / /字节范', featureName: '字节范最大字符数', formField: HELP_MAX_FORM_FIELDS.byteStyle },
  { feature: 'scale_new_heights', command: '/scale-new-heights / /勇攀高峰', featureName: '勇攀高峰最大字符数', formField: HELP_MAX_FORM_FIELDS.scaleNewHeights }
] as const;
const HELP_COMMAND_ROWS: HelpCommandRow[] = [
  {
    command: '/help',
    params: '无',
    description: '查看当前机器人支持的斜杠命令、可填参数和功能说明，并可配置当前会话的概率能力。'
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


function helpCommandsMarkdown() {
  return [
    '**命令总览**',
    '',
    '| 命令 | 参数 | 功能 |',
    '| --- | --- | --- |',
    ...HELP_COMMAND_ROWS.map((row) => `| \`${row.command}\` | ${row.params.replace(/\|/g, '\\|')} | ${row.description.replace(/\|/g, '\\|')} |`)
  ].join('\n');
}

function helpOverviewMarkdown() {
  return [
    '下面是当前支持的斜杠命令。群聊里需要先 @ 机器人，单聊里可以直接发送。',
    '',
    helpCommandsMarkdown(),
    '',
    openApiHelpMarkdown(),
    '',
    '**概率能力配置**',
    '当前会话的 `rate` 会优先覆盖环境变量默认值；单项 `rate` 不能超过全局默认值的 10 倍。输入支持 `0.05` 或 `5` 表示 5%；超出范围会按最大值保存，异常值会被忽略。',
    '',
    '**补充说明**',
    '- 下方表单还支持设置 `/byte-style` 与 `/scale-new-heights` 的 `--max`。',
    '- 也支持通过多选下拉，批量新增或取消 `/douyin` 订阅。',
    '- 可设置未命中 `/users` 时，兜底指令是否弹出 @ 人员选择卡片。'
  ].join('\n');
}

function openApiHelpMarkdown() {
  const base = openApiBaseUrl();
  return [
    '**OpenAPI**',
    '',
    '| 地址 | 参数说明 | 返回 |',
    '| --- | --- | --- |',
    `| \`${base}/open-api/v1/mm\` | 无 | JSON：\`{ data: { url } }\` |`,
    `| \`${base}/open-api/v1/mm/redirect\` | 无 | 302 重定向到随机抖音视频地址 |`,
    `| \`${base}/open-api/v1/byte-style?text=xxx\` | \`text\` 必填；\`color1\` / \`color2\` 可选，支持 \`#RRGGBB\`；\`scale\` 可选；\`gradientAngle\` 或 \`ga\` 可选，范围 \`0-360\` | \`image/png\` |`,
    `| \`${base}/open-api/v1/scale-new-heights?text=xxx\` | \`text\` 必填；\`color1\` / \`color2\` 可选，支持 \`#RRGGBB\`；\`scale\` 可选；\`gradientAngle\` 或 \`ga\` 可选，范围 \`0-360\` | \`image/png\` |`
  ].join('\n');
}

export function helpRateSettingSummary(botId: number, chatId: string, descriptor: HelpRateDescriptor, config: PassiveInteractionConfig) {
  const defaultRate = defaultRateForFeature(config, descriptor.feature);
  return descriptor.kind === 'passive'
    ? getPassiveFeatureSetting(botId, chatId, descriptor.feature, defaultRate)
    : getStyleStickerSetting(botId, chatId, descriptor.feature, defaultRate, config.styleStickerDefaultMaxChars, config.styleStickerMaxCharsLimit);
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
    element_id: `help_rate_enabled_${descriptor.formField}`,
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
    element_id: `help_fallback_mention_${HELP_FALLBACK_MENTION_FORM_FIELDS.enabled}`,
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
    element_id: `help_rate_${descriptor.formField}`,
    name: descriptor.formField,
    placeholder: plainText(`支持 0.05 或 5`),
    default_value: formatEditableRateValue(setting.rate),
    max_length: 8
  };
}

function helpRateFormHeader() {
  return {
    tag: 'column_set',
    element_id: 'help_rate_form_header',
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
            content: '**配置项**'
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [
          {
            tag: 'markdown',
            content: '**状态**'
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 3,
        elements: [
          {
            tag: 'markdown',
            content: '**rate**'
          }
        ]
      }
    ]
  };
}

function helpMaxInput(descriptor: HelpMaxDescriptor, maxChars: number) {
  return {
    tag: 'input',
    element_id: `help_max_${descriptor.formField}`,
    name: descriptor.formField,
    placeholder: plainText('输入最大字符数'),
    default_value: String(maxChars),
    max_length: 4
  };
}

function helpMaxItem(descriptor: HelpMaxDescriptor, maxChars: number, maxLimit: number) {
  return {
    tag: 'column_set',
    element_id: `help_max_item_${descriptor.formField}`,
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 6,
        elements: [
          {
            tag: 'markdown',
            content: `**${descriptor.featureName}**\n命令：\`${descriptor.command}\`\n最大值：\`${maxLimit}\`；当前：\`${maxChars}\``
          }
        ]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 4,
        elements: [helpMaxInput(descriptor, maxChars)]
      }
    ]
  };
}

function helpDouyinMultiSelect(field: string, placeholderText: string, options: DouyinClickTextOption[], emptyText: string) {
  return {
    tag: 'multi_select_static',
    element_id: `help_douyin_${field}`,
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

function helpRateItem(descriptor: HelpRateDescriptor, setting: PassiveChatSetting | StyleStickerChatSetting) {
  return {
    tag: 'column_set',
    element_id: `help_rate_item_${descriptor.formField}`,
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
            content: `**${descriptor.featureName}**\n命令：\`${descriptor.command}\`\n最大值：\`${formatRatePercent(setting.maxRate)}\`；全局默认：\`${formatRatePercent(setting.defaultRate)}\`；当前：\`${setting.enabled ? '开启' : '关闭'} / ${formatRatePercent(setting.rate)}\`${setting.hasCustomRate ? '（会话配置）' : '（继承全局）'}`
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

function helpRateSummaryMarkdown(botId: number, chatId: string) {
  const config = passiveInteractionConfig();
  return HELP_RATE_DESCRIPTORS
    .map((descriptor) => {
      const setting = helpRateSettingSummary(botId, chatId, descriptor, config);
      return `- \`${descriptor.command}\`：当前会话 \`${setting.enabled ? '开启' : '关闭'} / ${formatRatePercent(setting.rate)}\`${setting.hasCustomRate ? '（会话配置）' : '（继承全局）'}；全局默认 \`${formatRatePercent(setting.defaultRate)}\`；上限 \`${formatRatePercent(setting.maxRate)}\`${setting.isRateCapped ? '（历史值已按上限收敛）' : ''}`;
    })
    .join('\n');
}

function helpMaxSummaryMarkdown(botId: number, chatId: string) {
  const config = passiveInteractionConfig();
  return [
    '**当前最大字符数**',
    ...HELP_MAX_DESCRIPTORS.map((descriptor) => {
      const setting = getStyleStickerSetting(
        botId,
        chatId,
        descriptor.feature,
        defaultRateForFeature(config, descriptor.feature),
        config.styleStickerDefaultMaxChars,
        config.styleStickerMaxCharsLimit
      );
      return `- \`${descriptor.command}\`：当前 \`${setting.maxChars}\`${setting.hasCustomMax ? '（会话配置）' : '（默认）'}${setting.isCapped ? `（按上限 ${config.styleStickerMaxCharsLimit} 收敛）` : ''}`;
    })
  ].join('\n');
}

function helpDouyinSummaryMarkdown(bot: FeishuBot, chatId: string) {
  const subscriptions = currentChatDouyinSubscriptionsWithRecentUpdates(bot, chatId);
  return [
    '**当前 /douyin 订阅**',
    subscriptions.length > 0
      ? subscriptions.map((item) => `- \`${item.clickText}\`（${formatDateTimeText(item.updatedAt)}）`).join('\n')
      : '- 当前群聊暂无订阅'
  ].join('\n');
}

function helpCronSummaryMarkdown(botId: number, chatId: string) {
  const tasks = listChatCronTasks(botId, chatId);
  return [
    '**当前定时任务**',
    tasks.length > 0
      ? tasks.map((task, index) => `- ${cronTaskSummary(task, index)}`).join('\n')
      : '- 当前会话暂无定时任务'
  ].join('\n');
}

function helpFallbackMentionSummaryMarkdown(botId: number, chatId: string) {
  return `**兜底 @ 人员收集**\n- 未命中 \`/users\` 且执行兜底指令时，弹出 @ 人员选择卡片：\`${fallbackMentionCardEnabled(botId, chatId) ? '开启' : '关闭'}\``;
}

export function helpReadonlySummaryMarkdown(bot: FeishuBot, chatId: string) {
  return [
    helpRateSummaryMarkdown(bot.id, chatId),
    '',
    helpMaxSummaryMarkdown(bot.id, chatId),
    '',
    helpDouyinSummaryMarkdown(bot, chatId),
    '',
    helpCronSummaryMarkdown(bot.id, chatId),
    '',
    helpFallbackMentionSummaryMarkdown(bot.id, chatId),
    '',
    '如需再次编辑，请重新发送 `/help`。'
  ].join('\n');
}

function helpCronExprInput() {
  return {
    tag: 'input',
    element_id: `help_cron_${HELP_CRON_FORM_FIELDS.cronExpr}`,
    name: HELP_CRON_FORM_FIELDS.cronExpr,
    placeholder: plainText('cron 表达式，例如 */5 * * * *'),
    max_length: 64
  };
}

function helpCronCommandTextInput(defaultCommand: string) {
  return {
    tag: 'input',
    element_id: `help_cron_${HELP_CRON_FORM_FIELDS.commandText}`,
    name: HELP_CRON_FORM_FIELDS.commandText,
    placeholder: plainText(defaultCommand ? `命令文本，留空则使用默认兜底：${defaultCommand}` : '命令文本，例如 /douyin 随机甜妹 --count 1'),
    max_length: 500
  };
}

function helpCronDeleteMultiSelect(tasks: ChatCronTask[]) {
  return {
    tag: 'multi_select_static',
    element_id: `help_cron_${HELP_CRON_FORM_FIELDS.deleteTaskIds}`,
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

function helpCardButton(action: HelpCardAction) {
  return {
    tag: 'button',
    name: `help_probability_${action}`,
    text: plainText(action === 'submit' ? '提交' : action === 'withdraw' ? '撤回' : '取消'),
    type: action === 'submit' ? 'primary_filled' : action === 'withdraw' ? 'danger_filled' : 'default',
    width: 'fill',
    ...(action === 'withdraw' ? {} : { form_action_type: 'submit' }),
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: HELP_CARD_KIND,
          action
        }
      }
    ]
  };
}

export function buildHelpCard(
  bot: FeishuBot,
  chatId: string,
  options: { showRateForm?: boolean; notice?: string } = {}
) {
  const showRateForm = options.showRateForm !== false && Boolean(chatId);
  const config = passiveInteractionConfig();
    const currentCronTasks = listChatCronTasks(bot.id, chatId);
    const defaultCommand = getDefaultCommand(bot.id);
  const fallbackMentionEnabled = fallbackMentionCardEnabled(bot.id, chatId);
  const elements: object[] = [
    {
      tag: 'markdown',
      content: helpOverviewMarkdown()
    }
  ];

  elements.push({ tag: 'hr' });
  if (options.notice) {
    elements.push({
      tag: 'markdown',
      content: options.notice
    });
  }

  if (showRateForm) {
    elements.push({
      tag: 'form',
      element_id: HELP_RATE_FORM_NAME,
      name: HELP_RATE_FORM_NAME,
      direction: 'vertical',
      vertical_spacing: '10px',
        elements: [
          helpRateFormHeader(),
          { tag: 'hr' },
          ...HELP_RATE_DESCRIPTORS.flatMap((descriptor, index) => {
            const setting = helpRateSettingSummary(bot.id, chatId, descriptor, config);
            const parts: object[] = [helpRateItem(descriptor, setting)];
            if (index < HELP_RATE_DESCRIPTORS.length - 1) parts.push({ tag: 'hr' });
            return parts;
          }),
          { tag: 'hr' },
          {
            tag: 'markdown',
            content: '**随机生图最大字符数**'
          },
          ...HELP_MAX_DESCRIPTORS.flatMap((descriptor, index) => {
            const setting = getStyleStickerSetting(
              bot.id,
              chatId,
              descriptor.feature,
              defaultRateForFeature(config, descriptor.feature),
              config.styleStickerDefaultMaxChars,
              config.styleStickerMaxCharsLimit
            );
            const parts: object[] = [helpMaxItem(descriptor, setting.maxChars, config.styleStickerMaxCharsLimit)];
            if (index < HELP_MAX_DESCRIPTORS.length - 1) parts.push({ tag: 'hr' });
            return parts;
          }),
          { tag: 'hr' },
          {
            tag: 'markdown',
            content: '**/douyin 订阅管理**\n新增订阅：展示最近更新但当前群聊尚未订阅的 `click_text`；取消订阅：展示当前群聊已有订阅，并按对应数据最近更新时间从远到近排序。'
          },
          helpDouyinMultiSelect(
            HELP_DOUYIN_FORM_FIELDS.subscribe,
            '选择要订阅的模拟点击文案',
            recentUnsubscribedDouyinClickTexts(bot, chatId),
            '暂无可新增订阅项'
          ),
          helpDouyinMultiSelect(
            HELP_DOUYIN_FORM_FIELDS.unsubscribe,
            '选择要取消订阅的模拟点击文案',
            currentChatDouyinSubscriptionsWithRecentUpdates(bot, chatId),
            '当前群聊暂无可取消的订阅'
          ),
            { tag: 'hr' },
            {
              tag: 'markdown',
              content: '**/add-cron 管理**\n新增任务时请填写 cron 表达式，命令文本可留空以使用当前 bot 的默认兜底指令；删除时可多选当前会话已有任务。'
            },
            helpCronExprInput(),
            helpCronCommandTextInput(defaultCommand),
            helpCronDeleteMultiSelect(currentCronTasks),
            { tag: 'hr' },
            {
              tag: 'markdown',
              content: '**兜底 @ 人员收集**\n未命中 `/users` 且执行兜底指令时，是否弹出 @ 人员选择卡片。'
            },
            helpFallbackMentionEnabledSelect(fallbackMentionEnabled),
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          columns: [
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
              elements: [helpCardButton('withdraw')]
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
                elements: [helpCardButton('cancel')]
            },
            {
              tag: 'column',
              width: 'weighted',
              weight: 1,
                elements: [helpCardButton('submit')]
            }
          ]
        }
      ]
    });
  } else {
    elements.push({
      tag: 'markdown',
        content: helpReadonlySummaryMarkdown(bot, chatId)
    });
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: '8px',
      columns: [
        {
          tag: 'column',
          width: 'stretch',
          elements: [helpCardButton('withdraw')]
        }
      ]
    });
  }

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      summary: { content: 'DogeBot 命令帮助' }
    },
    header: {
      title: plainText('DogeBot 命令帮助'),
      template: 'blue'
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements
    }
  };
}

export async function replyHelpCard(bot: FeishuBot, messageId: string, chatId: string) {
  await replyCard(bot, messageId, buildHelpCard(bot, chatId));
}

export {
  HELP_CARD_KIND,
  HELP_RATE_FORM_NAME,
  HELP_RATE_FORM_FIELDS,
  HELP_MAX_FORM_FIELDS,
  HELP_DOUYIN_FORM_FIELDS,
  HELP_CRON_FORM_FIELDS,
  HELP_FALLBACK_MENTION_FORM_FIELDS,
  HELP_RATE_DESCRIPTORS,
  HELP_MAX_DESCRIPTORS,
  HELP_COMMAND_ROWS
};
