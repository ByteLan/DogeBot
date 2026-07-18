import type { ChatCronTask, CronField, FeishuBot, DouyinCommand } from '../types.js';
import { db } from '../db.js';
import { getBot } from './bot-management.js';
import { sendTextToChat } from './api.js';
import { randomDouyinAwemeIds } from '../douyin.js';
import { resolveValidAwemeId, type DouyinTriggerContext } from './douyin-guard.js';

let cronSchedulerTimer: NodeJS.Timeout | undefined;
let cronSchedulerRunning = false;

function parseCronField(raw: string, min: number, max: number): CronField {
  const values = new Set<number>();
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  const unrestricted = parts.length === 1 && parts[0] === '*';
  for (const part of parts) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
    let start = min;
    let end = max;
    if (rangePart.includes('-')) {
      const [from, to] = rangePart.split('-').map(Number);
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error(`invalid cron range: ${part}`);
      start = from;
      end = to;
    } else if (rangePart !== '*') {
      const value = Number(rangePart);
      if (!Number.isInteger(value)) throw new Error(`invalid cron value: ${part}`);
      start = value;
      end = value;
    }
    if (start < min || end > max || start > end) throw new Error(`cron value out of range: ${part}`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`empty cron field: ${raw}`);
  return { values, unrestricted };
}

export function nextCronRunAt(cronExpr: string, from = new Date()) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  const [minute, hour, dayOfMonth, month, dayOfWeek] = [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7)
  ];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const deadline = new Date(cursor.getTime() + 366 * 24 * 60 * 60 * 1000);
  while (cursor <= deadline) {
    const dow = cursor.getDay();
    const dowMatches = dayOfWeek.values.has(dow) || (dow === 0 && dayOfWeek.values.has(7));
    const domMatches = dayOfMonth.values.has(cursor.getDate());
    const dayMatches = dayOfMonth.unrestricted || dayOfWeek.unrestricted ? domMatches && dowMatches : domMatches || dowMatches;
    if (
      minute.values.has(cursor.getMinutes()) &&
      hour.values.has(cursor.getHours()) &&
      month.values.has(cursor.getMonth() + 1) &&
      dayMatches
    ) {
      return cursor;
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  throw new Error('无法计算下一次执行时间');
}

export function addCronTask(botId: number, chatId: string, cronExpr: string, commandText: string) {
  const nextRunAt = nextCronRunAt(cronExpr).toISOString();
  const result = db.prepare(`
    INSERT INTO feishu_chat_cron_tasks (bot_id, chat_id, cron_expr, command_text, next_run_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(botId, chatId, cronExpr, commandText, nextRunAt);
  return { id: Number(result.lastInsertRowid), nextRunAt };
}

export function listChatCronTasks(botId: number, chatId: string) {
  return db.prepare(`
    SELECT id, bot_id, chat_id, cron_expr, command_text, next_run_at
    FROM feishu_chat_cron_tasks
    WHERE bot_id = ? AND chat_id = ? AND enabled = 1
    ORDER BY next_run_at ASC, id ASC
  `).all(botId, chatId) as ChatCronTask[];
}

export function deleteCronTaskById(botId: number, chatId: string, taskId: number) {
  const result = db.prepare(`
    DELETE FROM feishu_chat_cron_tasks
    WHERE bot_id = ? AND chat_id = ? AND id = ?
  `).run(botId, chatId, taskId);
  return result.changes > 0;
}

export function cronTaskSummary(task: ChatCronTask, index: number) {
  return `${index + 1}. ${task.cron_expr} -> ${task.command_text}\n   下次执行：${task.next_run_at}`;
}

/**
 * Parse a douyin command from text. Inlined here to avoid circular dependency
 * with the command handler module.
 */
function parseDouyinCommand(text: string): DouyinCommand {
  const commandIndex = text.indexOf('/douyin');
  if (commandIndex < 0) {
    return {
      isDouyin: false,
      clickText: '',
      count: 1,
      hasCountFlag: false,
      shouldDelete: false,
      shouldSubscribe: false,
      shouldUnsubscribe: false,
      deleteAwemeId: '',
      hasInvalidCount: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  const argsText = text.slice(commandIndex + '/douyin'.length).trim();
  const hasDeleteFlag = /(?:^|\s)--delete(?:\s|$)/.test(argsText);
  const hasSubscribeFlag = /(?:^|\s)--subscribe(?:\s|$)/.test(argsText);
  const hasUnsubscribeFlag = /(?:^|\s)--unsubscribe(?:\s|$)/.test(argsText);
  const actionCount = [hasDeleteFlag, hasSubscribeFlag, hasUnsubscribeFlag].filter(Boolean).length;
  const deleteMatch = argsText.match(/(?:^|\s)--delete\s+(\S+)/);
  const deleteAwemeId = deleteMatch?.[1] || '';
  const hasInvalidDelete = hasDeleteFlag && !/^\d{6,}$/.test(deleteAwemeId);
  const hasCountFlag = /(?:^|\s)--count(?:\s|$)/.test(argsText);
  const countMatch = argsText.match(/(?:^|\s)--count\s+(\S+)/);
  const clickText = argsText
    .replace(/(?:^|\s)--delete(?:\s+\S+)?/, ' ')
    .replace(/(?:^|\s)--subscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--unsubscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--count(?:\s+\S+)?/, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!hasCountFlag) {
    return {
      isDouyin: true,
      clickText: actionCount > 0 ? clickText : argsText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: false,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  if (!countMatch) {
    return {
      isDouyin: true,
      clickText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: true,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  const count = Number(countMatch[1]);
  return {
    isDouyin: true,
    clickText,
    count: Number.isInteger(count) && count > 0 ? count : 1,
    hasCountFlag,
    shouldDelete: hasDeleteFlag,
    shouldSubscribe: hasSubscribeFlag,
    shouldUnsubscribe: hasUnsubscribeFlag,
    deleteAwemeId,
    hasInvalidCount: !Number.isInteger(count) || count <= 0,
    hasInvalidDelete,
    hasConflictingAction: actionCount > 1
  };
}

/**
 * Send douyin video messages. Inlined here to avoid circular dependency.
 */
async function sendDouyinMessages(
  bot: FeishuBot,
  clickText: string,
  count: number,
  sendMessage: (text: string) => Promise<void>,
  trigger: DouyinTriggerContext
) {
  const awemeRecords = randomDouyinAwemeIds(bot.user_id!, clickText, count);
  if (awemeRecords.length === 0) {
    await sendMessage(`暂无"${clickText}"的抖音收藏记录`);
    return;
  }
  const attempted = new Set<string>();
  for (const [index, record] of awemeRecords.entries()) {
    const awemeId = await resolveValidAwemeId(bot, clickText, record.aweme_id, trigger, attempted);
    try {
      await sendMessage(`https://www.douyin.com/video/${awemeId}`);
    } catch (error) {
      console.error('[feishu] douyin send failed', {
        botId: bot.id,
        userId: bot.user_id,
        clickText,
        awemeId,
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

async function executeCronTask(task: ChatCronTask) {
  const bot = getBot(task.bot_id);
  if (!bot || !bot.enabled) return;
  const douyinCommand = parseDouyinCommand(task.command_text);
  if (!douyinCommand.isDouyin) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 暂不支持该指令：${task.command_text}`);
    return;
  }
  if (douyinCommand.shouldDelete) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 不支持 /douyin --delete，请由管理员手动执行`);
    return;
  }
  if (!douyinCommand.clickText) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 配置错误：/douyin 缺少模拟点击文案，格式应为 /douyin {模拟点击文案} [--count n]`);
    return;
  }
  if (douyinCommand.hasInvalidCount) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 配置错误：/douyin 的 --count 必须为大于 0 的整数`);
    return;
  }
  if (bot.user_id == null) {
    await sendTextToChat(bot, task.chat_id, `定时任务 #${task.id} 执行失败：当前机器人未绑定用户`);
    return;
  }
  await sendDouyinMessages(
    bot,
    douyinCommand.clickText,
    douyinCommand.count,
    (messageText) => sendTextToChat(bot, task.chat_id, messageText),
    {
      chatId: task.chat_id,
      personId: '',
      personName: '定时任务',
      source: `定时任务 #${task.id}`
    }
  );
}

async function runCronSchedulerTick() {
  if (cronSchedulerRunning) return;
  cronSchedulerRunning = true;
  try {
    const now = new Date();
    const tasks = db.prepare(`
      SELECT id, bot_id, chat_id, cron_expr, command_text, next_run_at
      FROM feishu_chat_cron_tasks
      WHERE enabled = 1 AND next_run_at <= ?
      ORDER BY next_run_at ASC, id ASC
      LIMIT 20
    `).all(now.toISOString()) as ChatCronTask[];
    for (const task of tasks) {
      const nextRunAt = nextCronRunAt(task.cron_expr, now).toISOString();
      db.prepare(`
        UPDATE feishu_chat_cron_tasks
        SET last_run_at = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(now.toISOString(), nextRunAt, task.id);
      executeCronTask(task).catch((error) => console.error('[feishu:cron] task failed', { taskId: task.id, error }));
    }
  } finally {
    cronSchedulerRunning = false;
  }
}

export function startFeishuCronScheduler() {
  if (cronSchedulerTimer) return;
  cronSchedulerTimer = setInterval(() => void runCronSchedulerTick(), 30_000);
  void runCronSchedulerTick();
}

export function stopFeishuCronScheduler() {
  if (cronSchedulerTimer) clearInterval(cronSchedulerTimer);
  cronSchedulerTimer = undefined;
}
