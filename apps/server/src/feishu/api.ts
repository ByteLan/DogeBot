import type { FeishuBot, FeishuMessageDetails, FeishuMention } from '../types.js';
import { feishuJson, openBase, tenantAccessToken } from './client.js';

function idFromFeishuObject(value: any): string {
  if (typeof value === 'string') return value.trim();
  return String(value?.open_id || value?.user_id || value?.union_id || '').trim();
}

export async function createChatMessage(bot: FeishuBot, chatId: string, msgType: string, content: Record<string, unknown>) {
  const token = await tenantAccessToken(bot);
  try {
    const result = await feishuJson<{ data?: { message_id?: string } }>(`${openBase(bot.domain)}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receive_id: chatId, msg_type: msgType, content: JSON.stringify(content) })
    });
    const messageId = String(result.data?.message_id || '').trim();
    if (!messageId) throw new Error('chat message send failed: missing message_id');
    return messageId;
  } catch (error) {
    console.error('[feishu] chat message send failed', {
      botId: bot.id,
      chatId,
      msgType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function replyText(bot: FeishuBot, messageId: string, text: string, replyInThread = false) {
  const token = await tenantAccessToken(bot);
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: replyInThread })
    });
  } catch (error) {
    console.error('[feishu] text reply send failed', {
      botId: bot.id,
      messageId,
      textLength: text.length,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function replyMedia(
  bot: FeishuBot,
  messageId: string,
  media: { type: 'image'; key: string } | { type: 'sticker'; key: string },
  replyInThread = false
) {
  const token = await tenantAccessToken(bot);
  const payload = media.type === 'image'
    ? { msgType: 'image', content: { image_key: media.key } }
    : { msgType: 'sticker', content: { file_key: media.key } };
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: payload.msgType, content: JSON.stringify(payload.content), reply_in_thread: replyInThread })
    });
  } catch (error) {
    console.error('[feishu] media reply send failed', {
      botId: bot.id,
      messageId,
      mediaType: media.type,
      mediaKey: media.key,
      replyInThread,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function sendTextToChat(bot: FeishuBot, chatId: string, text: string) {
  await createChatMessage(bot, chatId, 'text', { text });
}

export async function createUserMessage(bot: FeishuBot, openId: string, msgType: string, content: Record<string, unknown>) {
  const token = await tenantAccessToken(bot);
  try {
    const result = await feishuJson<{ data?: { message_id?: string } }>(`${openBase(bot.domain)}/open-apis/im/v1/messages?receive_id_type=open_id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receive_id: openId, msg_type: msgType, content: JSON.stringify(content) })
    });
    const messageId = String(result.data?.message_id || '').trim();
    if (!messageId) throw new Error('user message send failed: missing message_id');
    return messageId;
  } catch (error) {
    console.error('[feishu] user message send failed', {
      botId: bot.id,
      openId,
      msgType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function sendTextToUser(bot: FeishuBot, openId: string, text: string) {
  return createUserMessage(bot, openId, 'text', { text });
}

export async function sendImageToChat(bot: FeishuBot, chatId: string, imageKey: string) {
  await createChatMessage(bot, chatId, 'image', { image_key: imageKey });
}

export async function sendStickerToChat(bot: FeishuBot, chatId: string, fileKey: string) {
  await createChatMessage(bot, chatId, 'sticker', { file_key: fileKey });
}

export async function isTopicChat(bot: FeishuBot, chatId: string) {
  const token = await tenantAccessToken(bot);
  const response = await feishuJson<{ data?: { chat?: { chat_mode?: string } } }>(
    `${openBase(bot.domain)}/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` }
    }
  );
  return response.data?.chat?.chat_mode === 'topic';
}

export async function fetchMessageById(bot: FeishuBot, messageId: string): Promise<FeishuMessageDetails | undefined> {
  const token = await tenantAccessToken(bot);
  const response = await feishuJson<{
    data?: {
      items?: Array<{
        message_id?: string;
        parent_id?: string;
        root_id?: string;
        thread_id?: string;
        chat_id?: string;
        msg_type?: string;
        deleted?: boolean;
        sender?: {
          id?: string | { open_id?: string; user_id?: string; union_id?: string };
          sender_type?: string;
        };
        body?: { content?: string };
        mentions?: FeishuMention[];
      }>;
    };
  }>(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });
  const item = response.data?.items?.[0];
  if (!item) return undefined;
  return {
    messageId: String(item.message_id || messageId).trim(),
    parentId: String(item.parent_id || '').trim(),
    rootId: String(item.root_id || '').trim(),
    threadId: String(item.thread_id || '').trim(),
    chatId: String(item.chat_id || '').trim(),
    senderId: idFromFeishuObject(item.sender?.id),
    senderType: String(item.sender?.sender_type || '').trim(),
    deleted: Boolean(item.deleted),
    message: {
      message_id: String(item.message_id || messageId).trim(),
      parent_id: String(item.parent_id || '').trim(),
      root_id: String(item.root_id || '').trim(),
      message_type: String(item.msg_type || '').trim(),
      content: typeof item.body?.content === 'string' ? item.body.content : '',
      mentions: Array.isArray(item.mentions) ? item.mentions : []
    }
  };
}

export async function addReaction(bot: FeishuBot, messageId: string, reactionType: string) {
  const token = await tenantAccessToken(bot);
  try {
    await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ reaction_type: { emoji_type: reactionType } })
    });
    console.log('[feishu] reaction send success', { botId: bot.id, messageId, reactionType });
  } catch (error) {
    console.error('[feishu] reaction send failed', {
      botId: bot.id,
      messageId,
      reactionType,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

export async function replyCard(bot: FeishuBot, messageId: string, card: object, replyInThread = false) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: replyInThread })
  });
}

export async function updateInteractiveMessage(bot: FeishuBot, messageId: string, card: object) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ content: JSON.stringify(card) })
  });
}

export async function deleteMessage(bot: FeishuBot, messageId: string) {
  const token = await tenantAccessToken(bot);
  await feishuJson(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` }
  });
}

export async function uploadImage(bot: FeishuBot, data: Buffer, fileName: string) {
  const token = await tenantAccessToken(bot);
  const form = new FormData();
  form.set('image_type', 'message');
  form.set('image', new Blob([new Uint8Array(data)]), fileName);
  const result = await feishuJson<{ data?: { image_key?: string } }>(`${openBase(bot.domain)}/open-apis/im/v1/images`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
  const imageKey = String(result.data?.image_key || '').trim();
  if (!imageKey) throw new Error('upload image failed: missing image_key');
  return imageKey;
}
