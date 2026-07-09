import type { FeishuBot, DouyinSubscriptionRecord, DefaultCommandRecord, SetDefaultCommandResult } from '../../types.js';
import { db } from '../../db.js';
import { randomDouyinAwemeIds } from '../../douyin.js';
import { sendTextToChat } from '../api.js';
import { getBot } from '../bot-management.js';

export async function sendDouyinMessages(bot: FeishuBot, clickText: string, count: number, sendMessage: (text: string) => Promise<void>) {
  const awemeRecords = randomDouyinAwemeIds(bot.user_id!, clickText, count);
  if (awemeRecords.length === 0) {
    await sendMessage(`暂无"${clickText}"的抖音收藏记录`);
    return;
  }
  for (const [index, record] of awemeRecords.entries()) {
    try {
      await sendMessage(`https://www.douyin.com/video/${record.aweme_id}`);
    } catch (error) {
      console.error('[feishu] douyin send failed', {
        botId: bot.id,
        userId: bot.user_id,
        clickText,
        awemeId: record.aweme_id,
        currentIndex: index + 1,
        totalCount: awemeRecords.length,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    if (index < awemeRecords.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

export function addDouyinSubscription(botId: number, chatId: string, clickText: string) {
  const result = db.prepare(`
    INSERT INTO feishu_douyin_subscriptions (bot_id, chat_id, click_text)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id, chat_id, click_text) DO UPDATE SET
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, clickText);
  return { created: result.changes > 0 };
}

export function removeDouyinSubscription(botId: number, chatId: string, clickText: string) {
  const result = db.prepare(`
    DELETE FROM feishu_douyin_subscriptions
    WHERE bot_id = ? AND chat_id = ? AND click_text = ?
  `).run(botId, chatId, clickText);
  return { deleted: result.changes };
}

export function getDouyinSubscriptionsByUserAndClickText(userId: number, clickText: string) {
  return db.prepare(`
    SELECT s.id, s.bot_id, s.chat_id, s.click_text
    FROM feishu_douyin_subscriptions s
    INNER JOIN feishu_bots b ON b.id = s.bot_id
    WHERE b.user_id = ? AND b.enabled = 1 AND s.click_text = ?
    ORDER BY s.id ASC
  `).all(userId, clickText) as DouyinSubscriptionRecord[];
}

export async function notifyDouyinSubscriptions(payload: { userId: number; clickText: string; awemeIds: string[] }) {
  if (!payload.clickText || payload.awemeIds.length === 0) return;
  const subscriptions = getDouyinSubscriptionsByUserAndClickText(payload.userId, payload.clickText);
  if (subscriptions.length === 0) return;

  for (const subscription of subscriptions) {
    const bot = getBot(subscription.bot_id);
    if (!bot || !bot.enabled) continue;

    for (const [index, awemeId] of payload.awemeIds.entries()) {
      try {
        await sendTextToChat(bot, subscription.chat_id, `https://www.douyin.com/video/${awemeId}`);
      } catch (error) {
        console.error('[feishu] douyin subscription send failed', {
          botId: bot.id,
          userId: payload.userId,
          chatId: subscription.chat_id,
          clickText: payload.clickText,
          awemeId,
          currentIndex: index + 1,
          totalCount: payload.awemeIds.length,
          error: error instanceof Error ? error.message : String(error)
        });
        break;
      }
      if (index < payload.awemeIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

export function getDefaultCommandRecord(botId: number): DefaultCommandRecord | undefined {
  const row = db.prepare('SELECT default_command, admin_user_id FROM feishu_bot_default_commands WHERE bot_id = ?').get(botId) as
    | { default_command: string; admin_user_id: string | null }
    | undefined;
  if (!row) return undefined;
  return {
    defaultCommand: row.default_command.trim(),
    adminUserId: row.admin_user_id?.trim() || ''
  };
}

export function getDefaultCommand(botId: number) {
  return getDefaultCommandRecord(botId)?.defaultCommand || '';
}

export function setDefaultCommand(botId: number, defaultCommand: string, adminUserId: string): SetDefaultCommandResult {
  const existing = getDefaultCommandRecord(botId);
  if (existing?.adminUserId && existing.adminUserId !== adminUserId) {
    return { ok: false, adminUserId: existing.adminUserId };
  }
  const assignedAdmin = !existing?.adminUserId;
  db.prepare(`
    INSERT INTO feishu_bot_default_commands (bot_id, default_command, admin_user_id)
    VALUES (?, ?, ?)
    ON CONFLICT(bot_id) DO UPDATE SET
      default_command = excluded.default_command,
      admin_user_id = CASE
        WHEN feishu_bot_default_commands.admin_user_id IS NULL OR feishu_bot_default_commands.admin_user_id = ''
        THEN excluded.admin_user_id
        ELSE feishu_bot_default_commands.admin_user_id
      END,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, defaultCommand, adminUserId);
  return { ok: true, assignedAdmin };
}
