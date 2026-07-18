import type { FeishuBot } from '../../types.js';
import { replyCard, sendTextToUser } from '../api.js';

export const DOUYIN_INVALID_CARD_KIND = 'douyin_invalid_confirm';

export type DouyinInvalidCardAction = 'delete' | 'cancel' | 'restore';

/** Card display state: awaiting confirmation vs. already soft-deleted. */
export type DouyinCardState = 'confirm' | 'deleted';

/**
 * Which flow produced the card, deciding the confirm-state heading / footer:
 * - invalid: keyword/auto probe found the video likely invalid
 * - valid: probe confirmed the video is live
 * - errored: probe was inconclusive (network error, treated as valid)
 * - command: admin manually ran /douyin --delete
 */
export type DouyinCardVariant = 'invalid' | 'valid' | 'errored' | 'command';

export type DouyinCardContext = {
  awemeId: string;
  /** user_id owning the douyin record, used to soft delete / restore. */
  userId: number;
  /** admin open_id allowed to operate this card. */
  adminUserId: string;
  variant: DouyinCardVariant;
  title: string;
  triggerChatId: string;
  triggerPersonId: string;
  triggerPersonName: string;
  /** where the card was triggered: keyword report, auto send path, or /douyin --delete. */
  source: string;
};

function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function callbackValue(context: DouyinCardContext, action: DouyinInvalidCardAction) {
  return {
    kind: DOUYIN_INVALID_CARD_KIND,
    action,
    awemeId: context.awemeId,
    userId: context.userId,
    adminUserId: context.adminUserId,
    variant: context.variant,
    title: context.title,
    triggerChatId: context.triggerChatId,
    triggerPersonId: context.triggerPersonId,
    triggerPersonName: context.triggerPersonName,
    source: context.source
  };
}

/** Left button: always "撤回" (withdraw the card). */
function cancelButton(context: DouyinCardContext) {
  return {
    tag: 'button',
    name: 'douyin_invalid_cancel',
    text: plainText('撤回'),
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: callbackValue(context, 'cancel') }]
  };
}

/** Right button: "删除" while confirming, "恢复" once deleted. */
function primaryButton(context: DouyinCardContext, state: DouyinCardState) {
  const action: DouyinInvalidCardAction = state === 'deleted' ? 'restore' : 'delete';
  return {
    tag: 'button',
    name: `douyin_invalid_${action}`,
    text: plainText(state === 'deleted' ? '恢复' : '删除'),
    type: state === 'deleted' ? 'primary' : 'danger_filled',
    width: 'fill',
    behaviors: [{ type: 'callback', value: callbackValue(context, action) }]
  };
}

function actionButtonColumns(context: DouyinCardContext, state: DouyinCardState) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [cancelButton(context)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [primaryButton(context, state)]
      }
    ]
  };
}

export function isDouyinInvalidCardAction(value: unknown): value is DouyinInvalidCardAction {
  return value === 'delete' || value === 'cancel' || value === 'restore';
}

function triggerPersonLabel(context: Pick<DouyinCardContext, 'triggerPersonName' | 'triggerPersonId'>) {
  return context.triggerPersonName && context.triggerPersonName !== context.triggerPersonId
    ? `${context.triggerPersonName}（${context.triggerPersonId}）`
    : context.triggerPersonId || '未知';
}

function confirmHeading(variant: DouyinCardVariant) {
  switch (variant) {
    case 'invalid':
      return '**⚠️ 抖音视频可能已失效**';
    case 'valid':
      return '**✅ 抖音视频检测有效**';
    case 'errored':
      return '**❔ 抖音视频检测未完成（网络异常，按有效处理）**';
    case 'command':
      return '**🗂️ 确认删除抖音收藏记录**';
  }
}

function titleFallback(variant: DouyinCardVariant) {
  switch (variant) {
    case 'invalid':
      return '（无法获取，疑似失效）';
    case 'valid':
      return '（未获取到标题）';
    case 'errored':
      return '（检测异常，未获取到标题）';
    case 'command':
      return '（未获取标题）';
  }
}

function confirmFooter(variant: DouyinCardVariant) {
  switch (variant) {
    case 'invalid':
      return '是否将该 aweme_id 从数据库中标记为删除？';
    case 'valid':
    case 'errored':
      return '如需仍将该 aweme_id 从数据库中标记为删除，可点击「删除」。';
    case 'command':
      return '是否将该 aweme_id 从数据库中标记为删除？';
  }
}

/** Render the card body for a given context + state. */
export function renderDouyinCardState(context: DouyinCardContext, state: DouyinCardState) {
  const heading = state === 'deleted' ? '**🗑️ 已删除该抖音收藏记录**' : confirmHeading(context.variant);
  const footer = state === 'deleted'
    ? '已标记为删除，可点击「恢复」撤销，或「撤回」关闭本卡片。'
    : confirmFooter(context.variant);
  const lines = [
    heading,
    '',
    `- **aweme_id**：\`${context.awemeId}\``,
    `- **标题**：${context.title || titleFallback(context.variant)}`,
    `- **触发群聊**：\`${context.triggerChatId || '未知'}\``,
    `- **触发人**：${triggerPersonLabel(context)}`,
    `- **触发来源**：${context.source}`,
    '',
    footer
  ];
  return {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'hr' },
        actionButtonColumns(context, state)
      ]
    }
  };
}

/** Card for a possibly-invalid detection: confirm state, invalid variant. */
export function buildDouyinInvalidCard(context: Omit<DouyinCardContext, 'variant'>) {
  return renderDouyinCardState({ ...context, variant: 'invalid' }, 'confirm');
}

/** Card summarizing a completed validity check (valid / inconclusive). */
export function buildDouyinResultCard(context: Omit<DouyinCardContext, 'variant'> & { outcome: 'valid' | 'errored' }) {
  const { outcome, ...rest } = context;
  return renderDouyinCardState({ ...rest, variant: outcome }, 'confirm');
}

/** Confirmation card for the manual /douyin --delete command. */
export function buildDouyinDeleteConfirmCard(context: Omit<DouyinCardContext, 'variant'>) {
  return renderDouyinCardState({ ...context, variant: 'command' }, 'confirm');
}

/**
 * Notify the /set-default admin (in their p2p chat) about a possibly-invalid
 * douyin video: send the video URL, then reply a confirmation card in-thread.
 * Never deletes anything automatically — deletion is the admin's decision.
 */
export async function notifyAdminDouyinInvalid(bot: FeishuBot, context: Omit<DouyinCardContext, 'variant'>) {
  const urlMessageId = await sendTextToUser(
    bot,
    context.adminUserId,
    `https://www.douyin.com/video/${context.awemeId}`
  );
  await replyCard(bot, urlMessageId, buildDouyinInvalidCard(context), true);
}

/**
 * Notify the /set-default admin (in their p2p chat) about a completed check that
 * did NOT look invalid (valid or inconclusive): send the video URL, then reply an
 * info card in-thread with delete/withdraw buttons so the admin can still act.
 */
export async function notifyAdminDouyinResult(
  bot: FeishuBot,
  context: Omit<DouyinCardContext, 'variant'> & { outcome: 'valid' | 'errored' }
) {
  const urlMessageId = await sendTextToUser(
    bot,
    context.adminUserId,
    `https://www.douyin.com/video/${context.awemeId}`
  );
  await replyCard(bot, urlMessageId, buildDouyinResultCard(context), true);
}
