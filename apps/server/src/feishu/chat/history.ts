import type { FeishuBot } from '../../types.js';
import { feishuJson, openBase, tenantAccessToken } from '../client.js';
import { normalizeMessage, record, string } from './normalize.js';
import type { ChatMessage, ChatSummary, HistoryPage } from './types.js';

type Job = { botId: number; signal: AbortSignal; start: () => void; reject: (reason: unknown) => void };
const queue: Job[] = [];
const runningByBot = new Map<number, number>();
let running = 0;

function drain() {
  while (running < 8) {
    const index = queue.findIndex((job) => (runningByBot.get(job.botId) ?? 0) < 2);
    if (index < 0) break;
    const [job] = queue.splice(index, 1);
    if (job.signal.aborted) { job.reject(job.signal.reason); continue; }
    running++;
    runningByBot.set(job.botId, (runningByBot.get(job.botId) ?? 0) + 1);
    job.start();
  }
}

function limited<T>(botId: number, signal: AbortSignal, task: () => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    if (queue.length >= 32) { reject(new Error('查询队列繁忙，请稍后重试')); return; }
    const abort = () => { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i, 1); reject(signal.reason); } };
    const job: Job = { botId, signal, reject, start: () => {
      signal.removeEventListener('abort', abort);
      void task().then(resolve, reject).finally(() => {
        running--;
        const n = (runningByBot.get(botId) ?? 1) - 1;
        if (n) runningByBot.set(botId, n); else runningByBot.delete(botId);
        drain();
      });
    } };
    signal.addEventListener('abort', abort, { once: true });
    queue.push(job);
    drain();
  });
}

// Only in-flight work is shared. Settled responses are never retained.
const inflight = new Map<string, { controller: AbortController; promise: Promise<unknown>; users: number }>();
export function readFeishu(bot: FeishuBot, path: string, callerSignal: AbortSignal): Promise<unknown> {
  if (callerSignal.aborted) return Promise.reject(callerSignal.reason);
  const key = `${bot.id}:${path}`;
  let item = inflight.get(key);
  if (!item || item.controller.signal.aborted) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]);
    const promise = limited(bot.id, signal, async () => {
      const token = await tenantAccessToken(bot);
      const result = await feishuJson<unknown>(`${openBase(bot.domain)}/open-apis${path}`, {
        headers: { authorization: `Bearer ${token}` }, signal, cache: 'no-store'
      });
      if (record(result).code !== 0 || !record(result).data) throw new Error('飞书返回了无效的查询结果');
      return record(result).data;
    });
    item = { controller, promise, users: 0 };
    inflight.set(key, item);
    const current = item;
    void promise.finally(() => { if (inflight.get(key) === current) inflight.delete(key); }).catch(() => {});
  }
  const shared = item;
  shared.users++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (callback: () => void) => {
      if (done) return;
      done = true;
      callerSignal.removeEventListener('abort', abort);
      if (--shared.users === 0) shared.controller.abort();
      callback();
    };
    const abort = () => finish(() => reject(callerSignal.reason));
    callerSignal.addEventListener('abort', abort, { once: true });
    shared.promise.then((value) => finish(() => resolve(value)), (error: unknown) => finish(() => reject(error)));
  });
}

export function chatSummary(botId: number, value: unknown): ChatSummary {
  const item = record(value);
  return { botId, chatId: string(item.chat_id), name: string(item.name) || string(item.chat_id), avatar: string(item.avatar) || undefined,
    chatMode: item.chat_mode === 'topic' ? 'topic' : item.chat_mode === 'group' ? 'group' : 'unknown' };
}

export async function getChat(bot: FeishuBot, chatId: string, signal: AbortSignal) {
  const data = record(await readFeishu(bot, `/im/v1/chats/${encodeURIComponent(chatId)}`, signal));
  return chatSummary(bot.id, { ...record(data.chat ?? data), chat_id: chatId });
}

export async function getMessage(bot: FeishuBot, chatId: string, messageId: string, signal: AbortSignal): Promise<ChatMessage> {
  const data = record(await readFeishu(bot, `/im/v1/messages/${encodeURIComponent(messageId)}?card_msg_content_type=user_card_content`, signal));
  const message = normalizeMessage(bot.id, Array.isArray(data.items) ? data.items[0] : undefined);
  if (!message || message.chatId !== chatId) throw new ChatAccessError('消息不属于当前群或已不可访问');
  return message;
}

export class ChatAccessError extends Error {}

export async function getHistory(bot: FeishuBot, chatId: string, options: {
  pageToken?: string; snapshotEndTimeSeconds?: string; threadId?: string; rootMessageId?: string;
}, signal: AbortSignal): Promise<HistoryPage> {
  if (options.threadId) {
    if (!options.rootMessageId) throw new ChatAccessError('话题查询缺少根消息');
    const root = await getMessage(bot, chatId, options.rootMessageId, signal);
    if (root.threadId !== options.threadId) throw new ChatAccessError('话题不属于当前群');
  }
  const end = options.threadId ? undefined : options.snapshotEndTimeSeconds ?? String(Math.floor(Date.now() / 1000) + 1);
  const query = new URLSearchParams({ container_id_type: options.threadId ? 'thread' : 'chat', container_id: options.threadId ?? chatId,
    sort_type: 'ByCreateTimeDesc', page_size: '50', card_msg_content_type: 'user_card_content' });
  if (end) query.set('end_time', end);
  if (options.pageToken) query.set('page_token', options.pageToken);
  const data = record(await readFeishu(bot, `/im/v1/messages?${query}`, signal));
  if (!Array.isArray(data.items)) throw new Error('飞书未返回消息列表');
  const normalized = data.items.map((item: unknown) => normalizeMessage(bot.id, item));
  if (normalized.some((item) => !item)) throw new Error('飞书消息缺少必要标识');
  const items = normalized.filter((item): item is ChatMessage => Boolean(item));
  if (items.some((item) => item.chatId !== chatId)) throw new ChatAccessError('消息不属于当前群');
  if (data.has_more === true && !string(data.page_token)) throw new Error('飞书分页结果缺少下一页标记');
  items.sort((a, b) => a.createTimeMs - b.createTimeMs || a.messageId.localeCompare(b.messageId));
  return { items, hasMore: data.has_more === true, nextPageToken: string(data.page_token) || undefined, snapshotEndTimeSeconds: end };
}
