import type { FeishuBot } from '../types.js';
import { db } from '../db.js';
import { checkDouyinAwemeValidity, extractAwemeIdFromText } from '../douyin-check.js';
import { randomDouyinAwemeIdExcluding, findDouyinRecordByAwemeId, softDeleteDouyinAwemeRecords } from '../douyin.js';
import { notifyAdminDouyinInvalid } from './cards/douyin-invalid-card.js';

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
 * Keyword-triggered check ("视频无效" / "视频失效"): verify a single aweme_id and,
 * if it looks invalid, notify the admin with a delete-confirmation card. Never
 * deletes automatically. Returns true when a check was performed.
 */
export async function reportPossiblyInvalidAweme(
  bot: FeishuBot,
  awemeId: string,
  trigger: DouyinTriggerContext
): Promise<boolean> {
  if (bot.user_id == null) return false;
  const normalizedId = String(awemeId || '').trim();
  if (!/^\d{6,}$/.test(normalizedId)) return false;
  const record = findDouyinRecordByAwemeId(bot.user_id, normalizedId);
  if (!record || record.status === 'delete') return false;

  const validity = await checkDouyinAwemeValidity(normalizedId);
  if (validity.errored || validity.valid) return true;
  await notifyAdmin(bot, normalizedId, validity.title, trigger);
  return true;
}

export function softDeleteAweme(userId: number, awemeId: string) {
  return softDeleteDouyinAwemeRecords(userId, awemeId);
}
