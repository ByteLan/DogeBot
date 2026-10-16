import type { FeishuBot } from '../../types.js';
import { FeishuApiError, feishuJson, openBase, tenantAccessToken } from '../client.js';
import { publishChatEvent } from './events.js';
import { getMessage } from './history.js';

export class RecallMessageError extends Error {
  constructor(message: string, readonly status: 400 | 403, readonly upstreamCode?: number) { super(message); }
}

export async function recallOwnMessage(bot: FeishuBot, chatId: string, messageId: string, signal: AbortSignal) {
  const message = await getMessage(bot, chatId, messageId, signal);
  if (message.sender.type !== 'app' || !message.sender.id
    || (message.sender.id !== bot.app_id && message.sender.id !== bot.bot_open_id)) {
    throw new RecallMessageError('只能撤回当前机器人自己发送的消息', 403);
  }
  if (!message.deleted) {
    const token = await tenantAccessToken(bot);
    try {
      // Complete an accepted write even if its desktop HTTP connection goes away.
      const result = await feishuJson<{ code?: number }>(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000)
      });
      if (result.code !== 0) throw new Error('飞书未返回明确的撤回结果，请刷新消息确认');
    } catch (error) {
      if (!(error instanceof FeishuApiError)) throw error;
      if (error.code === 230009) throw new RecallMessageError('消息已超出企业管理员设置的可撤回时限', 400, error.code);
      if (error.code === 230026 || error.code === 230027) throw new RecallMessageError('机器人没有撤回此消息的权限，请检查飞书应用权限并发布', 403, error.code);
      if (error.code === 230054) throw new RecallMessageError('飞书不支持撤回此类型的消息', 400, error.code);
      if (error.code !== 230110) throw error; // Already deleted by another client is a confirmed success.
    }
  }
  const result = { chatId, messageId, recallTimeMs: Date.now() };
  publishChatEvent(bot, { type: 'message.recalled', botId: bot.id, ...result });
  return result;
}
