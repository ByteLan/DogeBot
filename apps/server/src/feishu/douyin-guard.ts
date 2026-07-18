import type { FeishuBot } from '../types.js';
import { db } from '../db.js';
import { checkDouyinAwemeValidity, extractAwemeIdFromText, type DouyinValidity } from '../douyin-check.js';
import { randomDouyinAwemeIdExcluding, findDouyinRecordByAwemeId, softDeleteDouyinAwemeRecords, restoreDouyinAwemeRecords } from '../douyin.js';
import { notifyAdminDouyinInvalid, notifyAdminDouyinResult } from './cards/douyin-invalid-card.js';
import { fetchMessageById } from './api.js';
import { parseFeishuMessage, referencedMessageIds } from './message-parser.js';

export { extractAwemeIdFromText };

const MAX_VALIDITY_ATTEMPTS = 5;

export type DouyinTriggerContext = {
  chatId: string;
  personId: string;
  personName: string;
  /** human readable trigger source shown to the admin. */
  source: string;
};

/** Resolve the /set-default admin open_id for a bot, or '' when none is configured. */
export function botAdminUserId(botId: number) {
  const row = db
    .prepare('SELECT admin_user_id FROM feishu_bot_default_commands WHERE bot_id = ?')
    .get(botId) as { admin_user_id: string | null } | undefined;
  return row?.admin_user_id?.trim() || '';
}

async function notifyAdmin(bot: FeishuBot, awemeId: string, title: string, trigger: DouyinTriggerContext) {
  const adminUserId = botAdminUserId(bot.id);
  if (!adminUserId || bot.user_id == null) return;
  try {
    await notifyAdminDouyinInvalid(bot, {
      awemeId,
      userId: bot.user_id,
      adminUserId,
      title,
      triggerChatId: trigger.chatId,
      triggerPersonId: trigger.personId,
      triggerPersonName: trigger.personName,
      source: trigger.source
    });
  } catch (error) {
    console.error('[feishu] douyin invalid admin notify failed', {
      botId: bot.id,
      awemeId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function notifyAdminResult(
  bot: FeishuBot,
  awemeId: string,
  outcome: 'valid' | 'errored',
  title: string,
  trigger: DouyinTriggerContext
) {
  const adminUserId = botAdminUserId(bot.id);
  if (!adminUserId || bot.user_id == null) return;
  try {
    await notifyAdminDouyinResult(bot, {
      awemeId,
      outcome,
      userId: bot.user_id,
      adminUserId,
      title,
      triggerChatId: trigger.chatId,
      triggerPersonId: trigger.personId,
      triggerPersonName: trigger.personName,
      source: trigger.source
    });
  } catch (error) {
    console.error('[feishu] douyin result admin notify failed', {
      botId: bot.id,
      awemeId,
      outcome,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Given an initial aweme_id for a clickText group, verify it is still valid.
 * On invalid detection, notify the admin (private card), then re-draw another
 * aweme_id from the same group and re-check, up to MAX_VALIDITY_ATTEMPTS times.
 *
 * `attempted` accumulates every aweme_id checked (valid or invalid) so that the
 * caller can exclude them from later draws and the admin is not re-notified for
 * the same invalid id within one batch.
 *
 * Returns the first valid aweme_id found, or the last attempted one when every
 * attempt looked invalid / the pool was exhausted (so the original send flow can
 * still proceed with a best-effort link). Returns '' only when nothing was drawn.
 */
export async function resolveValidAwemeId(
  bot: FeishuBot,
  clickText: string,
  initialAwemeId: string,
  trigger: DouyinTriggerContext,
  attempted: Set<string> = new Set()
): Promise<string> {
  if (bot.user_id == null) return initialAwemeId;
  let candidate = initialAwemeId;
  let lastCandidate = '';

  for (let attempt = 0; attempt < MAX_VALIDITY_ATTEMPTS; attempt++) {
    if (!candidate) break;
    lastCandidate = candidate;
    attempted.add(candidate);
    const validity = await checkDouyinAwemeValidity(candidate);
    if (validity.valid || validity.errored) {
      // Valid, or the probe was inconclusive: keep this one to avoid false deletes.
      return candidate;
    }
    await notifyAdmin(bot, candidate, validity.title, trigger);
    candidate = randomDouyinAwemeIdExcluding(bot.user_id, clickText, [...attempted]);
  }

  // Exhausted attempts / pool: fall back to the last attempted id.
  return lastCandidate || initialAwemeId;
}

/**
 * Keyword-triggered check ("视频无效" / "视频失效"): verify a single aweme_id and
 * always notify the /set-default admin with the result. Invalid → delete-confirm
 * card; valid / inconclusive → button-less info card. Never deletes automatically.
 *
 * Returns the validity result so the caller can also reply the outcome in-thread
 * to the reporting user, or null when the aweme_id is not a known active record.
 */
export async function reportPossiblyInvalidAweme(
  bot: FeishuBot,
  awemeId: string,
  trigger: DouyinTriggerContext
): Promise<DouyinValidity | null> {
  if (bot.user_id == null) return null;
  const normalizedId = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(normalizedId)) return null;
  const record = findDouyinRecordByAwemeId(bot.user_id, normalizedId);
  if (!record || record.status === 'delete') return null;

  const validity = await checkDouyinAwemeValidity(normalizedId);
  console.log('[feishu] douyin keyword check', {
    botId: bot.id,
    awemeId: normalizedId,
    valid: validity.valid,
    errored: validity.errored,
    title: validity.title,
    source: trigger.source
  });
  if (validity.valid && !validity.errored) {
    await notifyAdminResult(bot, normalizedId, 'valid', validity.title, trigger);
  } else if (validity.errored) {
    await notifyAdminResult(bot, normalizedId, 'errored', validity.title, trigger);
  } else {
    await notifyAdmin(bot, normalizedId, validity.title, trigger);
  }
  return validity;
}

export function softDeleteAweme(userId: number, awemeId: string) {
  return softDeleteDouyinAwemeRecords(userId, awemeId);
}

export function softRestoreAweme(userId: number, awemeId: string) {
  return restoreDouyinAwemeRecords(userId, awemeId);
}

/**
 * Resolve the aweme_id a message refers to: prefer the current message text (last
 * run of 10+ digits), otherwise fall back to the referenced (quoted) message text.
 */
export async function resolveAwemeIdFromMessage(bot: FeishuBot, message: any, currentText: string) {
  const fromCurrent = extractAwemeIdFromText(currentText);
  if (fromCurrent) return fromCurrent;
  for (const referencedMessageId of referencedMessageIds(message)) {
    const referenced = await fetchMessageById(bot, referencedMessageId).catch(() => undefined);
    if (!referenced) continue;
    const referencedText = parseFeishuMessage(referenced.message).text;
    const fromReferenced = extractAwemeIdFromText(referencedText);
    if (fromReferenced) return fromReferenced;
  }
  return '';
}
