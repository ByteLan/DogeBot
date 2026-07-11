import type { FeishuBot, StyleStickerFeature, StyleStickerCardAction, HelpCardAction, HelpRateDescriptor, ProbabilisticFeature } from '../types.js';
import { passiveInteractionConfig, parseConfigurableRate } from '../config.js';
import { deleteMessage, updateInteractiveMessage, replyMedia, fetchMessageById } from './api.js';
import { rememberFeishuEventKey } from './event-dedup.js';
import { idFromFeishuObject } from './message-parser.js';
import { buildStyleStickerCard, buildStyleStickerHdrLink, renderStyleStickerCardState, STYLE_STICKER_FORM_FIELDS } from './cards/style-sticker-card.js';
import { buildHelpCard, HELP_CARD_KIND, HELP_RATE_FORM_FIELDS, HELP_MAX_FORM_FIELDS, HELP_DOUYIN_FORM_FIELDS, HELP_CRON_FORM_FIELDS, HELP_RATE_DESCRIPTORS, HELP_MAX_DESCRIPTORS, helpRateSettingSummary, helpRateEnabledField, recentUnsubscribedDouyinClickTexts, currentChatDouyinSubscriptionsWithRecentUpdates } from './cards/help-card.js';
import { styleStickerFeatureName, formatRatePercent, defaultRateForFeature, getPassiveFeatureSetting, setPassiveFeatureSetting, getStyleStickerSetting, setStyleStickerSetting } from './passive/settings.js';
import { addDouyinSubscription, removeDouyinSubscription, getDefaultCommand } from './commands/douyin.js';
import { addCronTask, listChatCronTasks, deleteCronTaskById } from './cron.js';
import { fallbackMentionCandidates } from './fallback-mentions.js';
import { FALLBACK_MENTION_CARD_KIND, FALLBACK_MENTION_FORM_FIELD, FALLBACK_MENTION_SEND_TO_GROUP_FORM_FIELD, isFallbackMentionCardAction, replyFallbackMentionOperatorCard } from './cards/fallback-mention-card.js';
import { listMentions, replyUsersCard, sendUsersCardToChat, upsertMentions } from './commands/users.js';

const STYLE_STICKER_CARD_KIND = 'style_sticker_generator';

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStyleStickerFeature(value: unknown): value is StyleStickerFeature {
  return value === 'byte_style' || value === 'scale_new_heights';
}

function isStyleStickerCardAction(value: unknown): value is StyleStickerCardAction {
  return value === 'preview' || value === 'send' || value === 'withdraw' || value === 'hdr';
}

function isHelpCardAction(value: unknown): value is HelpCardAction {
  return value === 'submit' || value === 'cancel' || value === 'withdraw';
}

function firstStringValue(value: unknown): string {
  if (Array.isArray(value)) return firstStringValue(value[0]);
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function formStringValue(formValue: Record<string, any>, field: string) {
  return firstStringValue(formValue[field]);
}

function formStringValues(formValue: Record<string, any>, field: string) {
  const raw = formValue[field];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const seen = new Set<string>();
  for (const value of values) {
    const text = firstStringValue(value);
    if (text) seen.add(text);
  }
  return [...seen];
}

function normalizeCardHexColor(value: unknown) {
  const text = firstStringValue(value);
  if (!text) return '';
  const normalized = text.startsWith('#') ? text : `#${text}`;
  return /^#[0-9a-fA-F]{6}$/.test(normalized) ? normalized.toLowerCase() : '';
}

function normalizeCardGradientAngle(value: unknown) {
  const parsed = Number(firstStringValue(value));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(360, Math.max(0, Math.round(parsed)));
}

function parseHdrEvValue(value: unknown): number | null {
  const text = firstStringValue(value);
  if (!text) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null;
  return parsed;
}

function parseHelpEnabledValue(value: unknown) {
  const text = firstStringValue(value);
  if (text === 'enabled') return true;
  if (text === 'disabled') return false;
  return undefined;
}

function parseCardActionContext(payload: any) {
  const event = payload?.event || payload;
  const messageId = String(
    event?.context?.open_message_id ||
      event?.open_message_id ||
      event?.message_id ||
      payload?.context?.open_message_id ||
      payload?.open_message_id ||
      ''
  ).trim();
  const chatId = String(
    event?.context?.open_chat_id ||
      event?.open_chat_id ||
      event?.chat_id ||
      payload?.context?.open_chat_id ||
      payload?.open_chat_id ||
      ''
  ).trim();
  if (!messageId || !chatId) return null;
  return {
    event,
    eventId: String(payload?.header?.event_id || event?.event_id || '').trim(),
    messageId,
    chatId,
    operatorId:
      idFromFeishuObject(event?.operator?.operator_id) ||
      idFromFeishuObject(event?.operator) ||
      idFromFeishuObject(event?.operator_id) ||
      String(payload?.open_id || payload?.user_id || '').trim(),
    formValue: isRecord(event?.action?.form_value) ? event.action.form_value : {}
  };
}

function parseStyleStickerCardActionPayload(payload: any) {
  const context = parseCardActionContext(payload);
  if (!context) return null;
  const actionValue = context.event?.action?.value;
  if (!isRecord(actionValue) || actionValue.kind !== STYLE_STICKER_CARD_KIND) return null;
  if (!isStyleStickerFeature(actionValue.feature) || !isStyleStickerCardAction(actionValue.action)) return null;

  return {
    eventId: context.eventId,
    messageId: context.messageId,
    chatId: context.chatId,
    feature: actionValue.feature,
    action: actionValue.action,
    formValue: context.formValue
  };
}

function parseHelpCardActionPayload(payload: any) {
  const context = parseCardActionContext(payload);
  if (!context) return null;
  const actionValue = context.event?.action?.value;
  if (!isRecord(actionValue) || actionValue.kind !== HELP_CARD_KIND) return null;
  if (!isHelpCardAction(actionValue.action)) return null;
  return {
    eventId: context.eventId,
    messageId: context.messageId,
    chatId: context.chatId,
    operatorId: context.operatorId,
    action: actionValue.action,
    formValue: context.formValue
  };
}

function parseFallbackMentionCardActionPayload(payload: any) {
  const context = parseCardActionContext(payload);
  if (!context) return null;
  const actionValue = context.event?.action?.value;
  if (!isRecord(actionValue) || actionValue.kind !== FALLBACK_MENTION_CARD_KIND || !isFallbackMentionCardAction(actionValue.action)) return null;

  const sourceMessageId = firstStringValue(actionValue.sourceMessageId);
  const atById = firstStringValue(actionValue.atById);
  const atByName = firstStringValue(actionValue.atByName);
  if (!sourceMessageId || !atById) return null;
  return {
    eventId: context.eventId,
    messageId: context.messageId,
    chatId: context.chatId,
    operatorId: context.operatorId,
    action: actionValue.action,
    sourceMessageId,
    atById,
    atByName: atByName || atById,
    formValue: context.formValue
  };
}

async function resolveReplyTargetFromCardMessage(bot: FeishuBot, cardMessageId: string) {
  const cardMessage = await fetchMessageById(bot, cardMessageId).catch(() => undefined);
  const fallback = {
    messageId: cardMessageId,
    replyInThread: Boolean(cardMessage?.threadId)
  };
  if (!cardMessage) return fallback;

  const targetMessageId = [cardMessage.parentId, cardMessage.rootId]
    .map((value) => String(value || '').trim())
    .find((value) => value && value !== cardMessage.messageId);
  if (!targetMessageId) return fallback;

  const targetMessage = await fetchMessageById(bot, targetMessageId).catch(() => undefined);
  return {
    messageId: targetMessage?.messageId || targetMessageId,
    replyInThread: targetMessage ? Boolean(targetMessage.threadId) : Boolean(cardMessage.threadId)
  };
}

export async function handleFeishuCardAction(bot: FeishuBot, payload: any) {
  const fallbackMentionParsed = parseFallbackMentionCardActionPayload(payload);
  if (fallbackMentionParsed) {
    if (fallbackMentionParsed.eventId && !rememberFeishuEventKey(`card:${fallbackMentionParsed.eventId}`)) return;

    if (fallbackMentionParsed.action === 'withdraw') {
      try {
        await deleteMessage(bot, fallbackMentionParsed.messageId);
      } catch (error) {
        console.error('[feishu] fallback mention card delete failed', {
          botId: bot.id,
          messageId: fallbackMentionParsed.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    try {
      const replyTarget = await resolveReplyTargetFromCardMessage(bot, fallbackMentionParsed.messageId);
      if (replyTarget.messageId !== fallbackMentionParsed.sourceMessageId) {
        throw new Error('fallback mention card source message does not match reply target');
      }
      const sourceMessage = await fetchMessageById(bot, fallbackMentionParsed.sourceMessageId);
      if (!sourceMessage) throw new Error('failed to fetch fallback mention source message');

      const candidates = await fallbackMentionCandidates(bot, sourceMessage.message);
      const candidatesById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const selectedIds = formStringValues(fallbackMentionParsed.formValue, FALLBACK_MENTION_FORM_FIELD);
      const selected = selectedIds
        .flatMap((id) => {
          const candidate = candidatesById.get(id);
          return candidate ? [candidate] : [];
        });
      if (selected.length === 0) {
        throw new Error('fallback mention card requires at least one valid selected user');
      }
      const newCount = fallbackMentionParsed.action === 'add' ? selected.length : undefined;
      const sendToGroupFormValue = formStringValue(
        fallbackMentionParsed.formValue,
        FALLBACK_MENTION_SEND_TO_GROUP_FORM_FIELD
      );
      const sendToGroup = sendToGroupFormValue === 'yes';
      const replyInThread = !sendToGroup;

      try {
        await deleteMessage(bot, fallbackMentionParsed.messageId);
      } catch (error) {
        console.error('[feishu] fallback mention card delete failed', {
          botId: bot.id,
          messageId: fallbackMentionParsed.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      upsertMentions(bot.id, fallbackMentionParsed.atById, fallbackMentionParsed.atByName, selected);
      const records = listMentions(bot.id, fallbackMentionParsed.atById, newCount);
      if (sendToGroup) {
        const { personListMessageId } = await sendUsersCardToChat(bot, fallbackMentionParsed.chatId, records);
        console.log('[feishu] fallback mention operator card preparing', {
          botId: bot.id,
          chatId: fallbackMentionParsed.chatId,
          personListMessageId,
          operatorId: fallbackMentionParsed.operatorId || ''
        });
        if (fallbackMentionParsed.operatorId) {
          try {
            await replyFallbackMentionOperatorCard(bot, personListMessageId, fallbackMentionParsed.operatorId);
            console.log('[feishu] fallback mention operator card sent', {
              botId: bot.id,
              personListMessageId,
              operatorId: fallbackMentionParsed.operatorId
            });
          } catch (error) {
            console.error('[feishu] fallback mention operator card send failed', {
              botId: bot.id,
              personListMessageId,
              operatorId: fallbackMentionParsed.operatorId,
              error: error instanceof Error ? error.message : String(error)
            });
            throw error;
          }
        }
        return;
      }
      await replyUsersCard(
        bot,
        fallbackMentionParsed.sourceMessageId,
        records,
        replyInThread,
        replyInThread
      );
    } catch (error) {
      console.error('[feishu] fallback mention card action failed', {
        botId: bot.id,
        messageId: fallbackMentionParsed.messageId,
        action: fallbackMentionParsed.action,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const parsed = parseStyleStickerCardActionPayload(payload);
  if (parsed) {
    if (parsed.eventId && !rememberFeishuEventKey(`card:${parsed.eventId}`)) return;

    if (parsed.action === 'withdraw') {
      try {
        await deleteMessage(bot, parsed.messageId);
      } catch (error) {
        console.error('[feishu] style sticker card delete failed', {
          botId: bot.id,
          messageId: parsed.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const text = formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.text) || styleStickerFeatureName(parsed.feature);
    const color1 = normalizeCardHexColor(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.customColor1)) ||
      formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.color1);
    const color2 = normalizeCardHexColor(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.customColor2)) ||
      formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.color2);
    const gradientAngle = normalizeCardGradientAngle(formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.gradientAngle));

    const hdrEvRaw = formStringValue(parsed.formValue, STYLE_STICKER_FORM_FIELDS.hdrEv) || '';

    try {
      const state = await renderStyleStickerCardState(bot, parsed.feature, text, {
        color1,
        color2,
        gradientAngle,
        hdrEv: hdrEvRaw
      });
      const ev = parseHdrEvValue(hdrEvRaw) ?? 4;
      const hdrLink = buildStyleStickerHdrLink(state, ev);

      if (parsed.action === 'preview' || parsed.action === 'hdr') {
        await updateInteractiveMessage(bot, parsed.messageId, buildStyleStickerCard({
          ...state,
          hdrLink
        }));
        return;
      }

      const replyTarget = await resolveReplyTargetFromCardMessage(bot, parsed.messageId);

      try {
        await deleteMessage(bot, parsed.messageId);
      } catch (error) {
        console.error('[feishu] style sticker card delete failed', {
          botId: bot.id,
          messageId: parsed.messageId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      await replyMedia(bot, replyTarget.messageId, { type: 'image', key: state.imageKey }, replyTarget.replyInThread);
    } catch (error) {
      console.error('[feishu] style sticker card action failed', {
        botId: bot.id,
        messageId: parsed.messageId,
        action: parsed.action,
        feature: parsed.feature,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  const helpParsed = parseHelpCardActionPayload(payload);
  if (!helpParsed) return;
  if (helpParsed.eventId && !rememberFeishuEventKey(`card:${helpParsed.eventId}`)) return;

  if (helpParsed.action === 'withdraw') {
    try {
      await deleteMessage(bot, helpParsed.messageId);
    } catch (error) {
      console.error('[feishu] help card delete failed', {
        botId: bot.id,
        messageId: helpParsed.messageId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  if (helpParsed.action === 'cancel') {
    await updateInteractiveMessage(bot, helpParsed.messageId, buildHelpCard(bot, helpParsed.chatId, {
      showRateForm: false,
      notice: '已取消本次概率修改。'
    }));
    return;
  }

  const config = passiveInteractionConfig();
  const ignored: string[] = [];
  const diffs: string[] = [];
  const updates = new Map<ProbabilisticFeature, { descriptor: HelpRateDescriptor; enabled?: boolean; rate?: number; maxChars?: number }>();
  for (const descriptor of HELP_RATE_DESCRIPTORS) {
    const current = helpRateSettingSummary(bot.id, helpParsed.chatId, descriptor, config);
    const nextEnabledValue = parseHelpEnabledValue(helpParsed.formValue[helpRateEnabledField(descriptor)]);
    const enabled = nextEnabledValue === undefined ? current.enabled : nextEnabledValue;
    const enabledChanged = enabled !== current.enabled;

    const raw = formStringValue(helpParsed.formValue, descriptor.formField);
    let rate = current.rate;
    let rateChanged = false;
    let capped = false;
    if (raw) {
      const parsedRate = parseConfigurableRate(raw);
      if (parsedRate === undefined) {
        ignored.push(`${descriptor.command} 的异常 rate 已忽略`);
      } else {
        const limitedRate = Math.min(parsedRate, current.maxRate);
        capped = limitedRate !== parsedRate;
        rate = limitedRate;
        rateChanged = Math.abs(rate - current.rate) > 1e-9;
      }
    }

    if (!enabledChanged && !rateChanged) {
      continue;
    }

    updates.set(descriptor.feature, {
      descriptor,
      enabled: enabledChanged ? enabled : undefined,
      rate: rateChanged ? rate : undefined
    });
    const parts: string[] = [];
    if (enabledChanged) parts.push(`状态 \`${current.enabled ? '开启' : '关闭'}\` -> \`${enabled ? '开启' : '关闭'}\``);
    if (rateChanged) parts.push(`rate \`${formatRatePercent(current.rate)}\` -> \`${formatRatePercent(rate)}\`${capped ? `（超出范围，按最大值 ${formatRatePercent(current.maxRate)} 保存）` : ''}`);
    diffs.push(`- \`${descriptor.command}\`：${parts.join('；')}`);
  }

  for (const descriptor of HELP_MAX_DESCRIPTORS) {
    const current = getStyleStickerSetting(
      bot.id,
      helpParsed.chatId,
      descriptor.feature,
      defaultRateForFeature(config, descriptor.feature),
      config.styleStickerDefaultMaxChars,
      config.styleStickerMaxCharsLimit
    );
    const raw = formStringValue(helpParsed.formValue, descriptor.formField);
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      ignored.push(`${descriptor.command} 的异常 max 已忽略`);
      continue;
    }
    const nextMax = Math.min(parsed, config.styleStickerMaxCharsLimit);
    if (nextMax === current.maxChars) continue;
    const existing = updates.get(descriptor.feature);
    updates.set(descriptor.feature, {
      descriptor: existing?.descriptor || HELP_RATE_DESCRIPTORS.find((item) => item.kind === 'style' && item.feature === descriptor.feature)!,
      enabled: existing?.enabled,
      rate: existing?.rate,
      maxChars: nextMax
    });
    diffs.push(`- \`${descriptor.command}\`：max \`${current.maxChars}\` -> \`${nextMax}\`${nextMax !== parsed ? `（超出范围，按最大值 ${config.styleStickerMaxCharsLimit} 保存）` : ''}`);
  }

  const availableSubscribeSet = new Set(recentUnsubscribedDouyinClickTexts(bot, helpParsed.chatId).map((item) => item.clickText));
  const availableUnsubscribeSet = new Set(currentChatDouyinSubscriptionsWithRecentUpdates(bot, helpParsed.chatId).map((item) => item.clickText));
  const subscribeSelections = formStringValues(helpParsed.formValue, HELP_DOUYIN_FORM_FIELDS.subscribe)
    .filter((value) => availableSubscribeSet.has(value));
  const unsubscribeSelections = formStringValues(helpParsed.formValue, HELP_DOUYIN_FORM_FIELDS.unsubscribe)
    .filter((value) => availableUnsubscribeSet.has(value));
  if (subscribeSelections.length > 0) {
    subscribeSelections.forEach((clickText) => {
      addDouyinSubscription(bot.id, helpParsed.chatId, clickText);
    });
    diffs.push(`- \`/douyin --subscribe\`：新增订阅 \`${subscribeSelections.join('`、`')}\``);
  }
  if (unsubscribeSelections.length > 0) {
    unsubscribeSelections.forEach((clickText) => {
      removeDouyinSubscription(bot.id, helpParsed.chatId, clickText);
    });
    diffs.push(`- \`/douyin --unsubscribe\`：取消订阅 \`${unsubscribeSelections.join('`、`')}\``);
  }

  const cronExpr = formStringValue(helpParsed.formValue, HELP_CRON_FORM_FIELDS.cronExpr);
  const cronCommandText = formStringValue(helpParsed.formValue, HELP_CRON_FORM_FIELDS.commandText);
  if (cronExpr || cronCommandText) {
    if (!cronExpr) {
      ignored.push('/add-cron 缺少 cron 表达式，已忽略新增');
    } else {
      const commandText = cronCommandText || getDefaultCommand(bot.id);
      if (!commandText) {
        ignored.push('/add-cron 缺少命令文本，且当前 bot 未设置 /set-default，已忽略新增');
      } else {
        try {
          const task = addCronTask(bot.id, helpParsed.chatId, cronExpr, commandText);
          diffs.push(`- \`/add-cron\`：新增任务 \`${cronExpr} -> ${commandText}\`（下次执行：${task.nextRunAt}）`);
        } catch (error) {
          ignored.push(error instanceof Error ? `/add-cron 新增失败：${error.message}` : '/add-cron 新增失败');
        }
      }
    }
  }

  const currentCronTasks = listChatCronTasks(bot.id, helpParsed.chatId);
  const currentCronTaskIds = new Set(currentCronTasks.map((task) => String(task.id)));
  const deleteCronTaskIds = formStringValues(helpParsed.formValue, HELP_CRON_FORM_FIELDS.deleteTaskIds)
    .filter((value) => currentCronTaskIds.has(value));
  if (deleteCronTaskIds.length > 0) {
    const deletedSummaries: string[] = [];
    for (const taskId of deleteCronTaskIds) {
      const task = currentCronTasks.find((item) => String(item.id) === taskId);
      if (!task) continue;
      if (deleteCronTaskById(bot.id, helpParsed.chatId, task.id)) {
        deletedSummaries.push(`${task.cron_expr} -> ${task.command_text}`);
      }
    }
    if (deletedSummaries.length > 0) {
      diffs.push(`- \`/add-cron --delete\`：删除任务 \`${deletedSummaries.join('`、`')}\``);
    }
  }

  updates.forEach(({ descriptor, enabled, rate, maxChars }) => {
    if (descriptor.kind === 'passive') {
      setPassiveFeatureSetting(bot.id, helpParsed.chatId, descriptor.feature, { enabled, rate });
      return;
    }
    setStyleStickerSetting(bot.id, helpParsed.chatId, descriptor.feature, { enabled, rate, maxChars });
  });

  const noticeLines: string[] = [];
  if (diffs.length > 0) {
    noticeLines.push('**已更新当前会话配置**');
    noticeLines.push(...diffs);
  } else {
    noticeLines.push('未检测到有效变更，已保持当前配置。');
  }
  if (ignored.length > 0) {
    noticeLines.push('', '**已忽略的输入**');
    noticeLines.push(...ignored.map((item) => `- ${item}`));
  }

  await updateInteractiveMessage(bot, helpParsed.messageId, buildHelpCard(bot, helpParsed.chatId, {
    showRateForm: false,
    notice: noticeLines.join('\n')
  }));
}
