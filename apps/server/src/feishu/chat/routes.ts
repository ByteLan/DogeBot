import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Router, raw, type Response } from 'express';
import { requireAuth, verifyToken, type AuthenticatedRequest } from '../../auth.js';
import type { FeishuBot } from '../../types.js';
import { getBot } from '../bot-management.js';
import { feishuConnectionManager } from '../connection.js';
import { FeishuApiError, feishuJson, openBase, tenantAccessToken } from '../client.js';
import { uploadImage } from '../api.js';
import { publishMessageResult, subscribeChatEvents } from './events.js';
import { ChatAccessError, chatSummary, getChat, getHistory, getMessage, readFeishu } from './history.js';
import { normalizeMessage, record, string } from './normalize.js';
import { RecallMessageError, recallOwnMessage } from './recall.js';
import type { ChatEvent } from './types.js';

type ChatRequest = AuthenticatedRequest & { chatBot?: FeishuBot };
class InputError extends Error {}
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function parameter(value: unknown, required = true) {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > 4096) throw new InputError('无效的请求参数');
  return value;
}

function identifier(value: unknown) {
  const result = parameter(value)!;
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(result)) throw new InputError('无效的标识');
  return result;
}

function operation(handler: (req: ChatRequest, res: Response, signal: AbortSignal) => Promise<unknown>) {
  return (req: ChatRequest, res: Response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    res.setHeader('Cache-Control', 'no-store');
    void handler(req, res, controller.signal).catch((error: unknown) => {
      if (res.destroyed || controller.signal.aborted) return;
      if (res.headersSent) { res.destroy(); return; }
      const upstream = error instanceof FeishuApiError ? error : undefined;
      const recallError = error instanceof RecallMessageError ? error : undefined;
      const resourceUnavailable = error instanceof ChatAccessError;
      const unavailable = upstream && [230002, 230013, 230017, 230027, 231203].includes(upstream.code);
      const limited = upstream?.httpStatus === 429 || upstream?.code === 99991400;
      const status = recallError?.status ?? (error instanceof InputError ? 400 : unavailable || resourceUnavailable ? 403 : limited ? 429 : 502);
      res.status(status).json({ error: error instanceof Error ? error.message : '飞书请求失败',
        code: recallError ? 'RECALL_REJECTED' : unavailable ? 'CHAT_UNAVAILABLE' : resourceUnavailable ? 'RESOURCE_UNAVAILABLE' : limited ? 'RATE_LIMITED' : 'CHAT_REQUEST_FAILED',
        upstreamCode: recallError?.upstreamCode ?? upstream?.code, retryAfterMs: limited ? 2000 : undefined });
      console.error('[feishu] chat request failed', { botId: req.chatBot?.id, status, upstreamCode: recallError?.upstreamCode ?? upstream?.code,
        error: error instanceof Error ? error.message : String(error) });
    }).finally(() => res.removeListener('close', abort));
  };
}

function stream(req: AuthenticatedRequest, res: Response) {
  const userId = req.user!.id;
  const token = (req.header('authorization') ?? '').slice(7);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  let blocked = false;
  let closed = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const close = () => { if (!closed) res.destroy(); };
  const send = (event: ChatEvent) => {
    if (closed) return;
    if (blocked) { close(); return; }
    if (!res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
      blocked = true;
      drainTimer = setTimeout(close, 1000);
      res.once('drain', () => { blocked = false; clearTimeout(drainTimer); });
    }
  };
  const unsubscribe = subscribeChatEvents(userId, send);
  const heartbeat = setInterval(() => {
    try {
      if (verifyToken(token)?.id !== userId) { close(); return; }
      if (!blocked && !res.write(': heartbeat\n\n')) close();
    } catch { close(); }
  }, 15_000);
  res.once('close', () => { closed = true; clearInterval(heartbeat); clearTimeout(drainTimer); unsubscribe(); });
  send({ type: 'ready', streamId: randomUUID(), connections: feishuConnectionManager.snapshot().filter((c) => c.userId === userId) });
}

export function createFeishuChatRouter() {
  const router = Router();
  router.get('/chat-events', requireAuth, stream);
  const chats = Router({ mergeParams: true });
  router.use('/bots/:botId/chats', requireAuth, (req: ChatRequest, res, next) => {
    const id = Number(req.params.botId);
    const bot = Number.isSafeInteger(id) && id > 0 ? getBot(id) : undefined;
    if (!bot || bot.user_id !== req.user?.id || !bot.enabled) { res.status(404).json({ error: 'bot not found' }); return; }
    req.chatBot = bot;
    next();
  }, chats);

  chats.get('/', operation(async (req, res, signal) => {
    const query = new URLSearchParams({ page_size: '50' });
    const token = parameter(req.query.pageToken, false);
    if (token) query.set('page_token', token);
    const data = record(await readFeishu(req.chatBot!, `/im/v1/chats?${query}`, signal));
    if (!Array.isArray(data.items)) throw new Error('飞书未返回群列表');
    res.json({ items: data.items.map((item: unknown) => chatSummary(req.chatBot!.id, item)), hasMore: data.has_more === true, nextPageToken: string(data.page_token) || undefined });
  }));
  chats.get('/:chatId', operation(async (req, res, signal) => {
    res.json({ chat: await getChat(req.chatBot!, identifier(req.params.chatId), signal) });
  }));
  chats.get('/:chatId/members', operation(async (req, res, signal) => {
    const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100' });
    const pageToken = parameter(req.query.pageToken, false);
    if (pageToken) query.set('page_token', pageToken);
    const data = record(await readFeishu(req.chatBot!, `/im/v1/chats/${identifier(req.params.chatId)}/members?${query}`, signal));
    if (!Array.isArray(data.items)) throw new Error('飞书未返回成员列表');
    res.json({ items: data.items.map((v: unknown) => { const item = record(v); return { id: string(item.member_id), name: string(item.name) }; }),
      hasMore: data.has_more === true, nextPageToken: string(data.page_token) || undefined });
  }));
  const history = operation(async (req, res, signal) => {
    const pageToken = parameter(req.query.pageToken, false);
    const end = parameter(req.query.snapshotEndTimeSeconds, false);
    const threadId = req.params.threadId ? identifier(req.params.threadId) : undefined;
    if (end && (!/^\d{1,12}$/.test(end) || threadId)) throw new InputError('无效的历史时间上界');
    if (pageToken && !threadId && !end) throw new InputError('分页缺少历史时间上界');
    res.json(await getHistory(req.chatBot!, identifier(req.params.chatId), { pageToken, snapshotEndTimeSeconds: end,
      threadId, rootMessageId: threadId ? identifier(req.query.rootMessageId) : undefined }, signal));
  });
  chats.get('/:chatId/messages', history);
  chats.get('/:chatId/threads/:threadId/messages', history);
  chats.get('/:chatId/messages/:messageId', operation(async (req, res, signal) => {
    res.json({ message: await getMessage(req.chatBot!, identifier(req.params.chatId), identifier(req.params.messageId), signal) });
  }));
  chats.delete('/:chatId/messages/:messageId', operation(async (req, res, signal) => {
    const result = await recallOwnMessage(req.chatBot!, identifier(req.params.chatId), identifier(req.params.messageId), signal);
    if (!res.destroyed) res.json(result);
  }));
  chats.post('/:chatId/messages', operation(async (req, res, signal) => {
    const bot = req.chatBot!;
    const chatId = identifier(req.params.chatId);
    const input = record(req.body);
    const requestId = string(input.clientRequestId);
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new InputError('发送动作缺少有效的 UUID');
    const msg = record(input.message);
    const type = string(msg.type);
    if (type !== 'text' && type !== 'image') throw new InputError('仅支持文本和图片发送');
    const text = string(msg.text);
    if (type === 'text' && (!text || text.length > 4000)) throw new InputError('文本长度须为 1 至 4000 字');
    const reply = input.reply == null ? undefined : record(input.reply);
    const parentId = reply ? identifier(reply.messageId) : undefined;
    if (reply && reply.mode !== 'chat' && reply.mode !== 'thread') throw new InputError('无效的回复方式');
    if (parentId) await getMessage(bot, chatId, parentId, signal);
    const token = await tenantAccessToken(bot);
    const content = type === 'text' ? { text } : { image_key: identifier(msg.imageKey) };
    const path = parentId ? `/im/v1/messages/${encodeURIComponent(parentId)}/reply` : '/im/v1/messages?receive_id_type=chat_id';
    // A disconnected HTTP consumer must not cause an automatic resend of an uncertain write.
    const result = await feishuJson<unknown>(`${openBase(bot.domain)}/open-apis${path}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000), body: JSON.stringify({ receive_id: parentId ? undefined : chatId, msg_type: type,
        content: JSON.stringify(content), reply_in_thread: reply?.mode === 'thread', uuid: requestId })
    });
    publishMessageResult(bot, result, requestId);
    const data = record(record(result).data);
    let message = normalizeMessage(bot.id, data);
    if (!message) message = await getMessage(bot, chatId, identifier(data.message_id), AbortSignal.timeout(20_000));
    if (!res.destroyed) res.json({ message, clientRequestId: requestId });
  }));
  chats.post('/:chatId/images', raw({ type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], limit: IMAGE_MAX_BYTES }), operation(async (req, res, signal) => {
    await getChat(req.chatBot!, identifier(req.params.chatId), signal);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new InputError('请选择 PNG、JPEG、WebP 或 GIF 图片');
    res.json({ imageKey: await uploadImage(req.chatBot!, req.body, 'desktop-image') });
  }));
  chats.get('/:chatId/messages/:messageId/resources/:fileKey', operation(async (req, res, signal) => {
    const bot = req.chatBot!;
    const id = identifier(req.params.messageId);
    const message = await getMessage(bot, identifier(req.params.chatId), id, signal);
    if (message.deleted) throw new ChatAccessError('消息已撤回');
    const key = identifier(req.params.fileKey);
    const token = await tenantAccessToken(bot);
    const response = await fetch(`${openBase(bot.domain)}/open-apis/im/v1/messages/${encodeURIComponent(id)}/resources/${encodeURIComponent(key)}?type=image`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), cache: 'no-store'
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('image/')) {
      await response.body?.cancel();
      throw new Error('图片不可访问');
    }
    if (Number(response.headers.get('content-length')) > IMAGE_MAX_BYTES) { await response.body.cancel(); throw new InputError('图片超过 10 MiB'); }
    res.setHeader('Content-Type', response.headers.get('content-type')!);
    const reader = response.body.getReader();
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > IMAGE_MAX_BYTES) throw new InputError('图片超过 10 MiB');
        if (!res.write(value)) await once(res, 'drain', { signal });
      }
      res.end();
    } finally { await reader.cancel().catch(() => {}); }
  }));
  return router;
}
