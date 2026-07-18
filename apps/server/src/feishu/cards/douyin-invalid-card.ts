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

function actionButton(action: DouyinInvalidCardAction, context: DouyinInvalidCardContext) {
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

export function isDouyinInvalidCardAction(value: unknown): value is DouyinInvalidCardAction {
  return value === 'delete' || value === 'cancel';
}

export function buildDouyinInvalidCard(context: DouyinInvalidCardContext) {
  const personLabel = context.triggerPersonName && context.triggerPersonName !== context.triggerPersonId
    ? `${context.triggerPersonName}（${context.triggerPersonId}）`
    : context.triggerPersonId || '未知';
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
        {
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
        }
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
