import { randomUUID } from 'node:crypto';
import { db } from '../../db.js';
import type { FeishuBot } from '../../types.js';
import { deleteMessage, replyCard, updateInteractiveMessage } from '../api.js';
import { buildUsersCopyCard, buildUsersCopyResultCard, type UsersCopyCardAction } from '../cards/users-copy-card.js';
import { listMentions, upsertMentions } from './users.js';

type UsersCopyRequest = {
  at_by: string;
  at_by_name: string;
  source_at_by: string;
  status: 'pending' | 'confirmed' | 'withdrawn';
  copied_count: number;
  added_count: number;
};

export async function replyUsersCopyCard(
  bot: FeishuBot,
  sourceMessageId: string,
  chatId: string,
  atBy: { id: string; name: string },
  sourceAtBy: string
) {
  const requestId = randomUUID();
  const count = listMentions(bot.id, sourceAtBy).length;
  db.prepare(`
    INSERT INTO feishu_users_copy_requests (id, bot_id, chat_id, at_by, at_by_name, source_at_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(requestId, bot.id, chatId, atBy.id, atBy.name, sourceAtBy);
  try {
    const messageId = await replyCard(bot, sourceMessageId, buildUsersCopyCard(requestId, count));
    if (!messageId) throw new Error('users copy card send failed: missing message_id');
    db.prepare('UPDATE feishu_users_copy_requests SET message_id = ? WHERE id = ?').run(messageId, requestId);
  } catch (error) {
    db.prepare('DELETE FROM feishu_users_copy_requests WHERE id = ?').run(requestId);
    throw error;
  }
}

export async function handleUsersCopyCardAction(bot: FeishuBot, context: {
  requestId: string;
  messageId: string;
  chatId: string;
  operatorId: string;
  action: UsersCopyCardAction;
}) {
  if (!context.operatorId || context.operatorId === 'unknown') return;
  // Resolve every identity from our request, not from editable callback values.
  // Persist the terminal state in the same transaction as the copied relationships.
  const result = db.transaction(() => {
    const request = db.prepare(`
      SELECT at_by, at_by_name, source_at_by, status, copied_count, added_count
      FROM feishu_users_copy_requests
      WHERE id = ? AND bot_id = ? AND chat_id = ? AND message_id = ? AND at_by = ?
    `).get(context.requestId, bot.id, context.chatId, context.messageId, context.operatorId) as UsersCopyRequest | undefined;
    if (!request) return undefined;
    if (request.status !== 'pending') return request;
    if (context.action === 'withdraw') {
      db.prepare(`UPDATE feishu_users_copy_requests SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(context.requestId);
      return { ...request, status: 'withdrawn' as const };
    }
    const records = listMentions(bot.id, request.source_at_by);
    const existing = new Set(listMentions(bot.id, request.at_by).map((record) => record.at_who));
    const addedCount = records.filter((record) => !existing.has(record.at_who)).length;
    upsertMentions(bot.id, request.at_by, request.at_by_name, records.map((record) => ({ id: record.at_who, name: record.at_who_name })));
    db.prepare(`
      UPDATE feishu_users_copy_requests
      SET status = 'confirmed', copied_count = ?, added_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(records.length, addedCount, context.requestId);
    return { ...request, status: 'confirmed' as const, copied_count: records.length, added_count: addedCount };
  })();
  if (!result) return;
  try {
    if (result.status === 'withdrawn' && context.action === 'withdraw') {
      await deleteMessage(bot, context.messageId);
    } else if (result.status === 'confirmed' && context.action === 'confirm') {
      await updateInteractiveMessage(bot, context.messageId, buildUsersCopyResultCard(result.copied_count, result.added_count));
    }
  } catch (error) {
    console.error('[feishu] users copy card action failed', {
      botId: bot.id,
      messageId: context.messageId,
      action: context.action,
      status: result.status,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
