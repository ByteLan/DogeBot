import type { ChatMessage } from './types.js';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function string(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function identity(value: unknown) {
  const item = record(value);
  return string(value) || string(item.open_id) || string(item.user_id) || string(item.union_id);
}

export function normalizeMessage(botId: number, value: unknown, eventSender?: unknown): ChatMessage | undefined {
  const raw = record(value);
  const messageId = string(raw.message_id);
  const chatId = string(raw.chat_id);
  if (!messageId || !chatId) return undefined;
  const sender = record(eventSender ?? raw.sender);
  const senderType = string(sender.sender_type);
  const contentValue = record(raw.body).content ?? raw.content;
  let content: unknown = contentValue;
  let contentState: ChatMessage['contentState'] = 'full';
  if (typeof contentValue === 'string') {
    if (Buffer.byteLength(contentValue) > 256 * 1024) {
      content = { text: '内容过大，请在飞书中查看' };
      contentState = 'summary';
    } else {
      try { content = JSON.parse(contentValue); }
      catch { content = { text: contentValue.slice(0, 4000) }; contentState = 'summary'; }
    }
  } else if (contentValue == null) {
    content = {};
    contentState = 'unavailable';
  } else if (Buffer.byteLength(JSON.stringify(contentValue)) > 256 * 1024) {
    content = { text: '内容过大，请在飞书中查看' };
    contentState = 'summary';
  }
  const time = (v: unknown) => {
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const deleted = raw.deleted === true;
  return {
    botId, chatId, messageId,
    rootId: string(raw.root_id) || undefined,
    parentId: string(raw.parent_id) || undefined,
    threadId: string(raw.thread_id) || undefined,
    sender: {
      id: identity(sender.id ?? sender.sender_id),
      idType: sender.id_type === 'app_id' ? 'app_id' : sender.id_type === 'open_id' || sender.sender_id ? 'open_id' : 'unknown',
      type: senderType === 'bot' || senderType === 'app' ? 'app' : senderType === 'user' ? 'user' : senderType === 'anonymous' ? 'anonymous' : 'unknown',
      displayName: string(sender.sender_name) || string(sender.name) || undefined
    },
    msgType: string(raw.msg_type) || string(raw.message_type) || 'unknown',
    createTimeMs: time(raw.create_time),
    updateTimeMs: time(raw.update_time) || undefined,
    deleted, contentState,
    content: deleted ? {} : content,
    mentions: deleted ? [] : (Array.isArray(raw.mentions) ? raw.mentions : []).map((v: unknown) => {
      const m = record(v);
      return { id: identity(m.id), name: string(m.name) || undefined, key: string(m.key) || undefined };
    })
  };
}
