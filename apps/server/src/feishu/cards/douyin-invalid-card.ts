import type { FeishuBot } from '../../types.js';
import { replyCard, sendTextToUser } from '../api.js';

export const DOUYIN_INVALID_CARD_KIND = 'douyin_invalid_confirm';

export type DouyinInvalidCardAction = 'delete' | 'cancel';

export type DouyinInvalidCardContext = {
  awemeId: string;
  /** user_id owning the douyin record, used to soft delete. */
  userId: number;
  /** admin open_id allowed to operate this card. */
  adminUserId: string;
  title: string;
  triggerChatId: string;
  triggerPersonId: string;
  triggerPersonName: string;
  /** where the check was triggered: keyword report or an auto send path. */
  source: string;
};

function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function actionButton(action: DouyinInvalidCardAction, context: { awemeId: string; userId: number; adminUserId: string }) {
  return {
    tag: 'button',
    name: `douyin_invalid_${action}`,
    text: plainText(action === 'delete' ? '删除' : '取消'),
    type: action === 'delete' ? 'danger_filled' : 'default',
    width: 'fill',
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: DOUYIN_INVALID_CARD_KIND,
          action,
          awemeId: context.awemeId,
          userId: context.userId,
          adminUserId: context.adminUserId
        }
      }
    ]
  };
}

function actionButtonColumns(context: { awemeId: string; userId: number; adminUserId: string }) {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: [
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [actionButton('cancel', context)]
      },
      {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [actionButton('delete', context)]
      }
    ]
  };
}

export function isDouyinInvalidCardAction(value: unknown): value is DouyinInvalidCardAction {
  return value === 'delete' || value === 'cancel';
}

function triggerPersonLabel(context: Pick<DouyinInvalidCardContext, 'triggerPersonName' | 'triggerPersonId'>) {
  return context.triggerPersonName && context.triggerPersonName !== context.triggerPersonId
    ? `${context.triggerPersonName}（${context.triggerPersonId}）`
    : context.triggerPersonId || '未知';
}

export function buildDouyinInvalidCard(context: DouyinInvalidCardContext) {
  const personLabel = triggerPersonLabel(context);
  const lines = [
    '**⚠️ 抖音视频可能已失效**',
    '',
    `- **aweme_id**：\`${context.awemeId}\``,
    `- **标题**：${context.title || '（无法获取，疑似失效）'}`,
    `- **触发群聊**：\`${context.triggerChatId || '未知'}\``,
    `- **触发人**：${personLabel}`,
    `- **触发来源**：${context.source}`,
    '',
    '是否将该 aweme_id 从数据库中标记为删除？'
  ];
  return {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'hr' },
        actionButtonColumns(context)
      ]
    }
  };
}

/**
 * Notify the /set-default admin (in their p2p chat) about a possibly-invalid
 * douyin video: send the video URL, then reply a confirmation card in-thread.
 * Never deletes anything automatically — deletion is the admin's decision.
 */
export async function notifyAdminDouyinInvalid(bot: FeishuBot, context: DouyinInvalidCardContext) {
  const urlMessageId = await sendTextToUser(
    bot,
    context.adminUserId,
    `https://www.douyin.com/video/${context.awemeId}`
  );
  await replyCard(bot, urlMessageId, buildDouyinInvalidCard(context), true);
}

export type DouyinResultCardContext = {
  awemeId: string;
  /** user_id owning the douyin record, used to soft delete. */
  userId: number;
  /** admin open_id allowed to operate this card. */
  adminUserId: string;
  /** 'valid' when the video is live, 'errored' when the probe was inconclusive. */
  outcome: 'valid' | 'errored';
  title: string;
  triggerChatId: string;
  triggerPersonId: string;
  triggerPersonName: string;
  source: string;
};

/** Build an info card summarizing a completed validity check, with delete/cancel buttons. */
export function buildDouyinResultCard(context: DouyinResultCardContext) {
  const heading = context.outcome === 'valid'
    ? '**✅ 抖音视频检测有效**'
    : '**❔ 抖音视频检测未完成（网络异常，按有效处理）**';
  const lines = [
    heading,
    '',
    `- **aweme_id**：\`${context.awemeId}\``,
    `- **标题**：${context.title || (context.outcome === 'valid' ? '（未获取到标题）' : '（检测异常，未获取到标题）')}`,
    `- **触发群聊**：\`${context.triggerChatId || '未知'}\``,
    `- **触发人**：${triggerPersonLabel(context)}`,
    `- **触发来源**：${context.source}`,
    '',
    '如需仍将该 aweme_id 从数据库中标记为删除，可点击「删除」。'
  ];
  return {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: lines.join('\n') },
        { tag: 'hr' },
        actionButtonColumns(context)
      ]
    }
  };
}

/**
 * Notify the /set-default admin (in their p2p chat) about a completed check that
 * did NOT look invalid (valid or inconclusive): send the video URL, then reply an
 * info card in-thread with delete/cancel buttons so the admin can still act.
 */
export async function notifyAdminDouyinResult(bot: FeishuBot, context: DouyinResultCardContext) {
  const urlMessageId = await sendTextToUser(
    bot,
    context.adminUserId,
    `https://www.douyin.com/video/${context.awemeId}`
  );
  await replyCard(bot, urlMessageId, buildDouyinResultCard(context), true);
}
