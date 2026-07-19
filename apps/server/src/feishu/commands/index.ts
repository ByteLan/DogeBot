import type { FeishuBot, ParsedFeishuMessage, RevertCommand, StyleStickerFeature } from '../../types.js';
import type { StickerFlavor } from '../../styleStickerCore.js';
import { passiveInteractionConfig } from '../../config.js';
import { replyText, replyMedia, replyCard, fetchMessageById, sendImageToChat, uploadImage, deleteMessage } from '../api.js';
import { parseFeishuMessage, messageChatId, isThreadMessage, senderIdentity, referencedMessageIds, debugFeishu, mentionedUsers, isManualReverseCommand } from '../message-parser.js';
import { parseUsersCommand, parseDouyinCommand, parseSetDefaultCommand, parseRevertCommand, isHelpCommand, parseAddCronCommand, parsePassiveToggleCommand, parseStyleStickerCommand } from './parsers.js';
import { sendDouyinMessages, getDefaultCommandRecord, getDefaultCommand, setDefaultCommand, addDouyinSubscription, removeDouyinSubscription } from './douyin.js';
import { replyUsersCard, softDeleteMentions, upsertMentions, topMentions, listMentions } from './users.js';
import { getPassiveFeatureSetting, setPassiveFeatureSetting, getStyleStickerSetting, setStyleStickerSetting, passiveFeatureUsage, styleStickerUsage, describePassiveFeatureSetting, describeStyleStickerSetting, formatRatePercent, maxRateForDefault, defaultRateForFeature } from '../passive/settings.js';
import { resolveAwemeIdFromMessage } from '../douyin-guard.js';
import { buildDouyinDeleteConfirmCard } from '../cards/douyin-invalid-card.js';
import { renderStyleStickerImage } from '../../styleStickers.js';
import { resolvePassiveMediaResource } from '../media/resource-cache.js';
import { buildMirroredImage, sendMirroredMediaResource } from '../media/mirror.js';
import { promises as fs } from 'node:fs';
import { replyHelpCard as _replyHelpCard } from '../cards/help-card.js';
import { replyStyleStickerGeneratorCard as _replyStyleStickerGeneratorCard } from '../cards/style-sticker-card.js';
import { addCronTask, listChatCronTasks, deleteCronTaskById, cronTaskSummary } from '../cron.js';

// --- Style sticker command helpers ---

function styleStickerFlavor(feature: StyleStickerFeature): StickerFlavor {
  return feature === 'byte_style' ? 'bs' : 'snh';
}

function styleStickerCommandName(feature: StyleStickerFeature) {
  return feature === 'byte_style' ? '/byte-style' : '/scale-new-heights';
}

async function sendStyleStickerToChat(
  bot: FeishuBot,
  chatId: string,
  feature: StyleStickerFeature,
  text: string,
  options: { color1?: unknown; color2?: unknown; gradientAngle?: unknown } = {}
) {
  const { image } = await renderStyleStickerImage(text, styleStickerFlavor(feature), options);
  const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(feature).slice(1)}.png`);
  await sendImageToChat(bot, chatId, imageKey);
}


// --- Referenced message text helper ---

async function referencedMessageText(bot: FeishuBot, message: any) {
  const candidateIds = referencedMessageIds(message);
  for (const referencedMessageId of candidateIds) {
    const referencedMessage = await fetchMessageById(bot, referencedMessageId).catch(() => undefined);
    const text = referencedMessage ? parseFeishuMessage(referencedMessage.message).text.trim() : '';
    if (text) return text;
  }
  return '';
}

// --- Revert command handler ---

async function revokeBotMessageById(bot: FeishuBot, requesterChatId: string, requesterId: string, targetMessageId: string) {
  const details = await fetchMessageById(bot, targetMessageId).catch(() => undefined);
  if (!details) return { ok: false as const, reason: '无法获取目标消息详情' };
  if (details.deleted) return { ok: false as const, reason: '该消息已被删除' };
  if (details.chatId && requesterChatId && details.chatId !== requesterChatId) {
    return { ok: false as const, reason: '目标消息不在当前会话' };
  }
  const senderIsBot = details.senderType === 'app' || details.senderId === bot.bot_open_id || details.senderId === bot.app_id;
  if (!senderIsBot) return { ok: false as const, reason: '目标消息不是 bot 发送的，无法撤回' };
  await deleteMessage(bot, targetMessageId);
  return { ok: true as const };
}

async function handleRevertCommand(bot: FeishuBot, event: any, messageId: string, command: RevertCommand) {
  if (command.hasUnknownArgs) {
    await replyText(bot, messageId, `用法：${command.command}（必须引用一条消息，或在 bot 发起的话题里使用）`);
    return true;
  }

  const requesterChatId = messageChatId(event?.message);
  const requester = senderIdentity(event);
  const requesterId = requester.id;
  const requesterName = String(
    event?.sender?.sender_name ||
      event?.sender?.name ||
      event?.sender?.sender_id?.name ||
      ''
  ).trim();
  const requesterLabel = requesterName
    ? requesterId && requesterId !== 'unknown'
      ? `${requesterName}（${requesterId}）`
      : requesterName
    : requesterId;
  const candidateIds = referencedMessageIds(event?.message);
  if (candidateIds.length === 0) {
    await replyText(bot, messageId, `${command.command} 必须引用一条消息，或在 bot 发起的话题里使用。`);
    return true;
  }

  const failures: string[] = [];
  for (const targetMessageId of candidateIds) {
    const result = await revokeBotMessageById(bot, requesterChatId, requesterId, targetMessageId);
    if (result.ok) {
      await replyText(bot, messageId, `已撤回消息：这条消息（触发人：${requesterLabel || 'unknown'}）`, true);
      return true;
    }
    failures.push(result.reason);
  }

  await replyText(bot, messageId, failures[0] || '未找到可撤回的 bot 消息');
  return true;
}

// --- Manual reverse command handler ---

async function resolveManualReverseMedia(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const chatId = messageChatId(event?.message);
  if (parsedMessage.imageKey || parsedMessage.stickerFileKey) {
    return resolvePassiveMediaResource(bot, messageId, chatId || 'unknown_chat', parsedMessage);
  }
  const candidateIds = referencedMessageIds(event?.message);
  for (const refId of candidateIds) {
    const refMsg = await fetchMessageById(bot, refId).catch(() => undefined);
    if (!refMsg) continue;
    const refParsed = parseFeishuMessage(refMsg.message);
    if (refParsed.imageKey || refParsed.stickerFileKey) {
      return resolvePassiveMediaResource(bot, refId, chatId || 'unknown_chat', refParsed);
    }
  }
  return undefined;
}

async function handleManualReverseCommand(bot: FeishuBot, event: any, messageId: string, parsedMessage: ParsedFeishuMessage) {
  const message = event?.message;
  const chatId = messageChatId(message);
  if (!chatId) {
    await replyText(bot, messageId, '当前消息缺少 chat_id，无法反转图片或表情包');
    return true;
  }

  try {
    const media = await resolveManualReverseMedia(bot, event, messageId, parsedMessage);
    if (!media) {
      await replyText(bot, messageId, '没找到可反转的图片或表情包；请在当前消息里带首图，或引用一条图片/表情包消息后再试。');
      return true;
    }

    if (isThreadMessage(message)) {
      const transformed = await buildMirroredImage(media, chatId);
      try {
        const uploadedImageKey = await uploadImage(bot, transformed.data, transformed.fileName);
        await replyMedia(bot, messageId, { type: 'image', key: uploadedImageKey }, true);
      } finally {
        await fs.unlink(transformed.filePath).catch(() => undefined);
      }
    } else {
      await sendMirroredMediaResource(bot, chatId, media);
    }
  } catch (error) {
    await replyText(bot, messageId, error instanceof Error ? `反转失败：${error.message}` : '反转失败');
  }
  return true;
}

// --- Help card and style sticker card ---

async function replyHelpCard(bot: FeishuBot, messageId: string, chatId: string) {
  await _replyHelpCard(bot, messageId, chatId);
}

async function replyStyleStickerGeneratorCard(bot: FeishuBot, messageId: string, feature: StyleStickerFeature) {
  await _replyStyleStickerGeneratorCard(bot, messageId, feature);
}

// --- Main command dispatcher ---

export async function handleFeishuCommand(bot: FeishuBot, event: any, messageId: string, text: string, options: { allowSetDefault: boolean }): Promise<boolean> {
  const message = event?.message;
  const chatId = String(message?.chat_id || '').trim();
  const parsedMessage = parseFeishuMessage(message);
  if (isHelpCommand(text)) {
    await replyHelpCard(bot, messageId, chatId);
    return true;
  }
  if (options.allowSetDefault) {
    const addCron = parseAddCronCommand(text);
    if (addCron.isAddCron) {
        if (addCron.hasConflictingAction || addCron.hasInvalidDelete) {
          await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "[命令]"；/add-cron --list；/add-cron --delete 序号');
          return true;
        }
      if (!chatId) {
          await replyText(bot, messageId, '当前消息缺少 chat_id，无法管理会话定时任务');
        return true;
      }
        if (addCron.shouldList) {
          const tasks = listChatCronTasks(bot.id, chatId);
          await replyText(
            bot,
            messageId,
            tasks.length > 0
              ? ['当前会话定时任务：', ...tasks.map((task, index) => cronTaskSummary(task, index))].join('\n')
              : '当前会话暂无定时任务'
          );
          return true;
      }
        if (addCron.deleteIndex !== undefined) {
          const tasks = listChatCronTasks(bot.id, chatId);
          const target = tasks[addCron.deleteIndex - 1];
          if (!target) {
            await replyText(bot, messageId, `未找到序号为 ${addCron.deleteIndex} 的定时任务，请先用 /add-cron --list 查看序号。`);
            return true;
          }
          deleteCronTaskById(bot.id, chatId, target.id);
          await replyText(bot, messageId, `已删除定时任务 ${addCron.deleteIndex}：${target.cron_expr} -> ${target.command_text}`);
          return true;
        }
        if (!addCron.cronExpr) {
          await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "[命令]"；如果已设置 /set-default，也可以省略第二个参数；也支持 /add-cron --list 和 /add-cron --delete 序号');
          return true;
        }
        const commandText = addCron.commandText || getDefaultCommand(bot.id);
        if (!commandText) {
          await replyText(bot, messageId, '用法：/add-cron "*/5 * * * *" "[命令]"；当前机器人未设置 /set-default，不能省略第二个参数');
          return true;
        }
        try {
          const task = addCronTask(bot.id, chatId, addCron.cronExpr, commandText);
          await replyText(bot, messageId, `已添加定时任务 #${task.id}，下次执行：${task.nextRunAt}\n${addCron.cronExpr} -> ${commandText}`);
        } catch (error) {
          await replyText(bot, messageId, error instanceof Error ? `添加定时任务失败：${error.message}` : '添加定时任务失败');
        }
        return true;
    }
    const setDefault = parseSetDefaultCommand(text);
    if (setDefault.isSetDefault) {
      const sender = senderIdentity(event);
      if (!sender.id || sender.id === 'unknown') {
        await replyText(bot, messageId, '无法识别当前发送用户，不能设置默认兜底指令');
        return true;
      }
      const currentDefault = getDefaultCommandRecord(bot.id);
      if (currentDefault?.adminUserId && currentDefault.adminUserId !== sender.id) {
        await replyText(bot, messageId, '只有首次设置默认兜底指令的管理员可以修改 /set-default');
        return true;
      }
      if (!setDefault.defaultCommand) {
        await replyText(bot, messageId, '用法：/set-default "{兜底指令}"');
        return true;
      }
      const result = setDefaultCommand(bot.id, setDefault.defaultCommand, sender.id);
      if (!result.ok) {
        await replyText(bot, messageId, '只有首次设置默认兜底指令的管理员可以修改 /set-default');
        return true;
      }
      await replyText(
        bot,
        messageId,
        result.assignedAdmin
          ? `已设置默认兜底指令：${setDefault.defaultCommand}\n你已成为该机器人的 /set-default 管理员。`
          : `已设置默认兜底指令：${setDefault.defaultCommand}`
      );
      return true;
    }
  }
  const revertCommand = parseRevertCommand(text);
  if (revertCommand.isRevert) {
    return handleRevertCommand(bot, event, messageId, revertCommand);
  }
  if (isManualReverseCommand(text)) {
    return handleManualReverseCommand(bot, event, messageId, parsedMessage);
  }
  const passiveToggle = parsePassiveToggleCommand(text);
  const styleStickerCommand = parseStyleStickerCommand(text);
  if (styleStickerCommand.isStyleSticker) {
    const config = passiveInteractionConfig();
    const hasSettingUpdates =
      styleStickerCommand.shouldEnable ||
      styleStickerCommand.shouldDisable ||
      styleStickerCommand.rate !== undefined ||
      styleStickerCommand.maxChars !== undefined;
    if (styleStickerCommand.hasConflictingAction || styleStickerCommand.hasInvalidRate || styleStickerCommand.hasInvalidMax) {
      await replyText(bot, messageId, styleStickerUsage(styleStickerCommand.command));
      return true;
    }
    if (!chatId) {
      await replyText(bot, messageId, '当前消息缺少 chat_id，无法发送贴纸图片或设置当前会话随机生图');
      return true;
    }
    if (styleStickerCommand.rate !== undefined) {
      const maxRate = maxRateForDefault(defaultRateForFeature(config, styleStickerCommand.feature));
      if (styleStickerCommand.rate > maxRate) {
        await replyText(bot, messageId, `${styleStickerCommand.command} 的 --rate 不能超过 ${formatRatePercent(maxRate)}。`);
        return true;
      }
    }
    if (!styleStickerCommand.text && !hasSettingUpdates) {
      if (!isThreadMessage(message)) {
        const referencedText = await referencedMessageText(bot, message);
        if (referencedText) {
          try {
            await sendStyleStickerToChat(
              bot,
              chatId,
              styleStickerCommand.feature,
              referencedText.slice(0, config.styleStickerMaxCharsLimit)
            );
          } catch (error) {
            await replyText(
              bot,
              messageId,
              error instanceof Error ? `${styleStickerCommand.featureName}生图失败：${error.message}` : `${styleStickerCommand.featureName}生图失败`
            );
          }
          return true;
        }
      }
      try {
        await replyStyleStickerGeneratorCard(bot, messageId, styleStickerCommand.feature);
      } catch (error) {
        await replyText(
          bot,
          messageId,
          error instanceof Error ? `${styleStickerCommand.featureName}卡片生成失败：${error.message}` : `${styleStickerCommand.featureName}卡片生成失败`
        );
      }
      return true;
    }

    if (hasSettingUpdates) {
      setStyleStickerSetting(bot.id, chatId, styleStickerCommand.feature, {
        enabled: styleStickerCommand.shouldEnable ? true : styleStickerCommand.shouldDisable ? false : undefined,
        rate: styleStickerCommand.rate,
        maxChars: styleStickerCommand.maxChars
      });
    }

    if (styleStickerCommand.text) {
      // Cap the manual command text at the absolute limit before rendering.
      const stickerText = styleStickerCommand.text.slice(0, config.styleStickerMaxCharsLimit);
      try {
        if (isThreadMessage(message)) {
          const { image } = await renderStyleStickerImage(stickerText, styleStickerFlavor(styleStickerCommand.feature));
          const imageKey = await uploadImage(bot, image, `${styleStickerCommandName(styleStickerCommand.feature).slice(1)}.png`);
          await replyMedia(bot, messageId, { type: 'image', key: imageKey }, true);
        } else {
          await sendStyleStickerToChat(bot, chatId, styleStickerCommand.feature, stickerText);
        }
      } catch (error) {
        await replyText(
          bot,
          messageId,
          error instanceof Error ? `${styleStickerCommand.featureName}生图失败：${error.message}` : `${styleStickerCommand.featureName}生图失败`
        );
        return true;
      }
      if (hasSettingUpdates) {
        const setting = getStyleStickerSetting(
          bot.id,
          chatId,
          styleStickerCommand.feature,
          defaultRateForFeature(config, styleStickerCommand.feature),
          config.styleStickerDefaultMaxChars,
          config.styleStickerMaxCharsLimit
        );
        await replyText(bot, messageId, describeStyleStickerSetting(styleStickerCommand.feature, setting));
      }
      return true;
    }

    const setting = getStyleStickerSetting(
      bot.id,
      chatId,
      styleStickerCommand.feature,
      defaultRateForFeature(config, styleStickerCommand.feature),
      config.styleStickerDefaultMaxChars,
      config.styleStickerMaxCharsLimit
    );
    await replyText(bot, messageId, describeStyleStickerSetting(styleStickerCommand.feature, setting));
    return true;
  }
  if (passiveToggle.isPassiveToggle) {
    if (passiveToggle.hasConflictingAction || passiveToggle.hasInvalidRate || passiveToggle.hasUnknownArgs) {
      await replyText(bot, messageId, passiveFeatureUsage(passiveToggle.command));
      return true;
    }
    if (!chatId) {
      await replyText(bot, messageId, '当前消息缺少 chat_id，无法设置当前会话的被动交互开关');
      return true;
    }
    const config = passiveInteractionConfig();
    const defaultRate = defaultRateForFeature(config, passiveToggle.feature);
    const maxRate = maxRateForDefault(defaultRate);
    if (passiveToggle.rate !== undefined && passiveToggle.rate > maxRate) {
      await replyText(bot, messageId, `${passiveToggle.command} 的 --rate 不能超过 ${formatRatePercent(maxRate)}。`);
      return true;
    }
    const hasSettingUpdates = passiveToggle.shouldEnable || passiveToggle.shouldDisable || passiveToggle.rate !== undefined;
    if (hasSettingUpdates) {
      setPassiveFeatureSetting(bot.id, chatId, passiveToggle.feature, {
        enabled: passiveToggle.shouldEnable ? true : passiveToggle.shouldDisable ? false : undefined,
        rate: passiveToggle.rate
      });
    }
    const setting = getPassiveFeatureSetting(bot.id, chatId, passiveToggle.feature, defaultRate);
    await replyText(bot, messageId, describePassiveFeatureSetting(passiveToggle.featureName, setting));
    return true;
  }

  const douyinCommand = parseDouyinCommand(text);
  if (douyinCommand.isDouyin) {
    if (douyinCommand.hasConflictingAction) {
      await replyText(bot, messageId, '用法冲突：/douyin 同时只能使用一种动作参数（--delete、--subscribe、--unsubscribe）。常用：/douyin {模拟点击文案} [--count n]；/douyin --subscribe {模拟点击文案}');
      return true;
    }
    if (douyinCommand.shouldDelete) {
      const sender = senderIdentity(event);
      if (!sender.id || sender.id === 'unknown') {
        await replyText(bot, messageId, '无法识别当前发送用户，不能删除抖音收藏记录');
        return true;
      }
      const adminUserId = getDefaultCommandRecord(bot.id)?.adminUserId || '';
      if (!adminUserId) {
        await replyText(bot, messageId, '当前机器人还没有 /set-default 管理员，不能执行 /douyin --delete');
        return true;
      }
      if (adminUserId !== sender.id) {
        await replyText(bot, messageId, '只有该机器人的 /set-default 管理员可以执行 /douyin --delete');
        return true;
      }
      if (bot.user_id == null) {
        await replyText(bot, messageId, '当前机器人未绑定用户，无法删除抖音收藏记录');
        return true;
      }
      const deleteAwemeId = await resolveAwemeIdFromMessage(bot, message, text);
      if (!deleteAwemeId) {
        await replyText(bot, messageId, '用法：/douyin --delete，需要在消息里或引用消息里包含一串大于等于 10 位的数字 aweme_id');
        return true;
      }
      await replyCard(
        bot,
        messageId,
        buildDouyinDeleteConfirmCard({
          awemeId: deleteAwemeId,
          userId: bot.user_id,
          adminUserId,
          title: '',
          triggerChatId: chatId,
          triggerPersonId: sender.id,
          triggerPersonName: sender.name,
          source: '/douyin --delete 指令'
        }),
        true
      );
      return true;
    }
    if (douyinCommand.shouldSubscribe) {
      if (!douyinCommand.clickText) {
        await replyText(bot, messageId, '用法：/douyin --subscribe {模拟点击文案}。订阅的是该文案对应的 clickText 分组，例如 /douyin --subscribe 随机甜妹');
        return true;
      }
      if (douyinCommand.hasCountFlag) {
        await replyText(bot, messageId, '订阅模式不支持 --count；订阅只监听该 clickText 分组后续新增入库记录，请使用 /douyin --subscribe {模拟点击文案}');
        return true;
      }
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法订阅抖音更新');
        return true;
      }
      if (bot.user_id == null) {
        await replyText(bot, messageId, '当前机器人未绑定用户，无法订阅抖音更新');
        return true;
      }
      addDouyinSubscription(bot.id, chatId, douyinCommand.clickText);
      await replyText(bot, messageId, `已订阅当前会话的"${douyinCommand.clickText}"更新（按 clickText 分组）。后续桌面端同步时，只有该分组有新的 aweme_id 成功入库才会自动发送；已有记录不会补发。`);
      return true;
    }
    if (douyinCommand.shouldUnsubscribe) {
      if (!douyinCommand.clickText) {
        await replyText(bot, messageId, '用法：/douyin --unsubscribe {模拟点击文案}。取消的是当前会话对该 clickText 分组的订阅。');
        return true;
      }
      if (douyinCommand.hasCountFlag) {
        await replyText(bot, messageId, '取消订阅模式不支持 --count，请使用 /douyin --unsubscribe {模拟点击文案}');
        return true;
      }
      if (!chatId) {
        await replyText(bot, messageId, '当前消息缺少 chat_id，无法取消订阅抖音更新');
        return true;
      }
      const result = removeDouyinSubscription(bot.id, chatId, douyinCommand.clickText);
      if (result.deleted === 0) {
        await replyText(bot, messageId, `当前会话未订阅"${douyinCommand.clickText}"这个 clickText 分组`);
        return true;
      }
      await replyText(bot, messageId, `已取消当前会话对"${douyinCommand.clickText}"这个 clickText 分组的订阅`);
      return true;
    }
    if (!douyinCommand.clickText) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案} [--count n]；订阅新增记录：/douyin --subscribe {模拟点击文案}；取消订阅：/douyin --unsubscribe {模拟点击文案}');
      return true;
    }
    if (douyinCommand.hasInvalidCount) {
      await replyText(bot, messageId, '用法：/douyin {模拟点击文案} [--count n]，其中 n 必须为大于 0 的整数');
      return true;
    }
    if (bot.user_id == null) {
      await replyText(bot, messageId, '当前机器人未绑定用户，无法读取抖音收藏记录');
      return true;
    }
    const douyinSender = senderIdentity(event);
    await sendDouyinMessages(
      bot,
      douyinCommand.clickText,
      douyinCommand.count,
      (messageText) => replyText(bot, messageId, messageText),
      {
        chatId,
        personId: douyinSender.id,
        personName: douyinSender.name,
        source: '/douyin 指令'
      }
    );
    return true;
  }

  const command = parseUsersCommand(text);
  if (!command.isUsers) {
    return false;
  }

  const atBy = senderIdentity(event);
  const mentions = mentionedUsers(bot, message);
  const atWhos = mentions.map((mention) => mention.id);
  debugFeishu('users.command', {
    botId: bot.id,
    messageId,
    atBy,
    text,
    command,
    atWhos,
    acceptedMentions: mentions
  });
  if (command.shouldDelete) {
    softDeleteMentions(bot.id, atBy.id, atWhos);
  } else {
    upsertMentions(bot.id, atBy.id, atBy.name, mentions);
    if (command.shouldTop) topMentions(bot.id, atBy.id, atWhos);
  }

  await replyUsersCard(bot, messageId, listMentions(bot.id, atBy.id, command.newCount));
  return true;
}
