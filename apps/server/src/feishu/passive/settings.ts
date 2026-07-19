import type { PassiveFeature, ProbabilisticFeature, StyleStickerFeature, PassiveChatSetting, StyleStickerChatSetting, PassiveInteractionConfig } from '../../types.js';
import { db } from '../../db.js';

export function styleStickerFeatureName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '字节范' : '勇攀高峰';
}

export function formatRatePercent(rate: number) {
  const percent = Math.round(rate * 10000) / 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(2).replace(/\.?0+$/, '')}%`;
}

export function maxRateForDefault(defaultRate: number) {
  return Math.max(0, Math.min(1, defaultRate * 10));
}

export function defaultRateForFeature(config: PassiveInteractionConfig, feature: ProbabilisticFeature) {
  switch (feature) {
    case 'reaction':
      return config.reactionRate;
    case 'repeat':
      return config.repeatRate;
    case 'llm_reply':
      return config.imitateRate;
    case 'media_repeat':
      return config.imageRepeatRate;
    case 'image_reverse':
      return config.imageReverseImageRate;
    case 'sticker_reverse':
      return config.imageReverseStickerRate;
    case 'byte_style':
      return config.byteStyleRate;
    case 'scale_new_heights':
      return config.scaleNewHeightsRate;
  }
}

export function getPassiveFeatureSetting(
  botId: number,
  chatId: string,
  feature: PassiveFeature,
  defaultRate: number
): PassiveChatSetting {
  const defaultEnabled = feature === 'media_repeat' ? false : true;
  const maxRate = maxRateForDefault(defaultRate);
  if (!chatId) {
    return {
      enabled: defaultEnabled,
      rate: defaultRate,
      defaultRate,
      maxRate,
      hasCustomRate: false,
      isRateCapped: false
    };
  }
  const row = db.prepare(`
    SELECT enabled, rate
    FROM feishu_chat_passive_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; rate: number | null } | undefined;
  const customRate = typeof row?.rate === 'number' && Number.isFinite(row.rate) ? Math.max(0, Math.min(1, row.rate)) : undefined;
  const effectiveRate = customRate === undefined ? defaultRate : Math.min(customRate, maxRate);
  return {
    enabled: row ? row.enabled === 1 : defaultEnabled,
    rate: effectiveRate,
    defaultRate,
    maxRate,
    hasCustomRate: customRate !== undefined,
    isRateCapped: customRate !== undefined && effectiveRate < customRate
  };
}

export function setPassiveFeatureSetting(
  botId: number,
  chatId: string,
  feature: PassiveFeature,
  updates: { enabled?: boolean; rate?: number }
) {
  const current = db.prepare(`
    SELECT enabled, rate
    FROM feishu_chat_passive_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; rate: number | null } | undefined;
  const defaultEnabled = feature === 'media_repeat' ? false : true;
  const enabled = updates.enabled ?? (current ? current.enabled === 1 : defaultEnabled);
  const rate = updates.rate ?? (typeof current?.rate === 'number' && Number.isFinite(current.rate) ? current.rate : null);
  db.prepare(`
    INSERT INTO feishu_chat_passive_settings (bot_id, chat_id, feature, enabled, rate)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, chat_id, feature) DO UPDATE SET
      enabled = excluded.enabled,
      rate = excluded.rate,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, feature, enabled ? 1 : 0, rate);
}

export function getStyleStickerSetting(
  botId: number,
  chatId: string,
  feature: StyleStickerFeature,
  defaultRate: number,
  defaultMaxChars: number,
  maxCharsLimit: number,
): StyleStickerChatSetting {
  const maxRate = maxRateForDefault(defaultRate);
  if (!chatId) {
    const effectiveMaxChars = Math.min(defaultMaxChars, maxCharsLimit);
    return {
      enabled: true,
      rate: defaultRate,
      defaultRate,
      maxRate,
      hasCustomRate: false,
      isRateCapped: false,
      maxChars: effectiveMaxChars,
      hasCustomMax: false,
      isCapped: effectiveMaxChars < defaultMaxChars
    };
  }
  const row = db.prepare(`
    SELECT enabled, rate, max_chars
    FROM feishu_chat_style_sticker_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; rate: number | null; max_chars: number | null } | undefined;
  const customRate = typeof row?.rate === 'number' && Number.isFinite(row.rate) ? Math.max(0, Math.min(1, row.rate)) : undefined;
  const customMax = row?.max_chars && row.max_chars > 0 ? row.max_chars : undefined;
  const configuredMaxChars = customMax || defaultMaxChars;
  const effectiveMaxChars = Math.min(configuredMaxChars, maxCharsLimit);
  const effectiveRate = customRate === undefined ? defaultRate : Math.min(customRate, maxRate);
  return {
    enabled: row ? row.enabled === 1 : true,
    rate: effectiveRate,
    defaultRate,
    maxRate,
    hasCustomRate: customRate !== undefined,
    isRateCapped: customRate !== undefined && effectiveRate < customRate,
    maxChars: effectiveMaxChars,
    hasCustomMax: Boolean(customMax),
    isCapped: effectiveMaxChars < configuredMaxChars
  };
}

export function setStyleStickerSetting(
  botId: number,
  chatId: string,
  feature: StyleStickerFeature,
  updates: { enabled?: boolean; rate?: number; maxChars?: number }
) {
  const current = db.prepare(`
    SELECT enabled, rate, max_chars
    FROM feishu_chat_style_sticker_settings
    WHERE bot_id = ? AND chat_id = ? AND feature = ?
  `).get(botId, chatId, feature) as { enabled: number; rate: number | null; max_chars: number | null } | undefined;
  const enabled = updates.enabled ?? (current ? current.enabled === 1 : true);
  const rate = updates.rate ?? (typeof current?.rate === 'number' && Number.isFinite(current.rate) ? current.rate : null);
  const maxChars = updates.maxChars ?? (current?.max_chars && current.max_chars > 0 ? current.max_chars : null);
  db.prepare(`
    INSERT INTO feishu_chat_style_sticker_settings (bot_id, chat_id, feature, enabled, rate, max_chars)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, chat_id, feature) DO UPDATE SET
      enabled = excluded.enabled,
      rate = excluded.rate,
      max_chars = excluded.max_chars,
      updated_at = CURRENT_TIMESTAMP
  `).run(botId, chatId, feature, enabled ? 1 : 0, rate, maxChars);
}

export function passiveFeatureUsage(command: string) {
  return `用法：${command} [--enable|--disable] [--rate 概率]`;
}

export function styleStickerUsage(command: string) {
  return `用法：${command} 文案内容；或 ${command} [--enable|--disable] [--rate 概率] [--max 字符数]`;
}

export function describePassiveFeatureSetting(featureName: string, setting: PassiveChatSetting) {
  return `当前会话${featureName}已${setting.enabled ? '开启' : '关闭'}，当前概率：${formatRatePercent(setting.rate)}${setting.hasCustomRate ? '（会话配置）' : '（全局默认）'}，全局默认：${formatRatePercent(setting.defaultRate)}，可设置上限：${formatRatePercent(setting.maxRate)}${setting.isRateCapped ? '（历史配置已按上限收敛）' : ''}`;
}

export function describeStyleStickerSetting(feature: StyleStickerFeature, setting: StyleStickerChatSetting) {
  return `当前会话${styleStickerFeatureName(feature)}随机生图已${setting.enabled ? '开启' : '关闭'}，当前概率：${formatRatePercent(setting.rate)}${setting.hasCustomRate ? '（会话配置）' : '（全局默认）'}，全局默认：${formatRatePercent(setting.defaultRate)}，可设置上限：${formatRatePercent(setting.maxRate)}${setting.isRateCapped ? '（历史配置已按上限收敛）' : ''}；最长处理字符数：${setting.maxChars}${setting.hasCustomMax ? '' : '（默认）'}${setting.isCapped ? '（受上限限制）' : ''}`;
}
