import { SseParser } from './sse';
import type { ChatEvent, ChatMessage, ChatSummary, HistoryPage, SendMessageInput } from './types';

export class ChatApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export class ChatApi {
  constructor(readonly baseUrl: string, private readonly token: string) {}
  async fetch(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, cache: 'no-store',
      headers: { authorization: `Bearer ${this.token}`, ...init.headers } });
    if (!response.ok) {
      const error = await response.json().catch(() => ({})) as { error?: string; code?: string };
      throw new ChatApiError(error.error ?? `HTTP ${response.status}`, response.status, error.code);
    }
    return response;
  }
  async json<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await this.fetch(path, { signal, method: body == null ? 'GET' : 'POST',
      headers: body == null ? {} : { 'content-type': 'application/json' }, body: body == null ? undefined : JSON.stringify(body) });
    return response.json() as Promise<T>;
  }
  path(botId: number, chatId?: string) {
    return `/api/feishu/bots/${botId}/chats${chatId ? `/${encodeURIComponent(chatId)}` : ''}`;
  }
  me(signal: AbortSignal) { return this.json<{ user: { id: number; username: string } }>('/api/me', signal); }
  groups(botId: number, signal: AbortSignal, token?: string) {
    return this.json<{ items: ChatSummary[]; hasMore: boolean; nextPageToken?: string }>(`${this.path(botId)}${token ? `?pageToken=${encodeURIComponent(token)}` : ''}`, signal);
  }
  chat(botId: number, chatId: string, signal: AbortSignal) {
    return this.json<{ chat: ChatSummary }>(this.path(botId, chatId), signal);
  }
  members(botId: number, chatId: string, signal: AbortSignal, pageToken?: string) {
    return this.json<{ items: Array<{ id: string; name: string }>; hasMore: boolean; nextPageToken?: string }>(
      `${this.path(botId, chatId)}/members${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`, signal);
  }
  history(botId: number, chatId: string, signal: AbortSignal, options: {
    pageToken?: string; snapshotEndTimeSeconds?: string; threadId?: string; rootMessageId?: string;
  } = {}) {
    const query = new URLSearchParams();
    if (options.pageToken) query.set('pageToken', options.pageToken);
    if (options.snapshotEndTimeSeconds) query.set('snapshotEndTimeSeconds', options.snapshotEndTimeSeconds);
    if (options.rootMessageId) query.set('rootMessageId', options.rootMessageId);
    const path = options.threadId ? `/threads/${encodeURIComponent(options.threadId)}/messages` : '/messages';
    return this.json<HistoryPage>(`${this.path(botId, chatId)}${path}?${query}`, signal);
  }
  detail(botId: number, chatId: string, id: string, signal: AbortSignal) {
    return this.json<{ message: ChatMessage }>(`${this.path(botId, chatId)}/messages/${encodeURIComponent(id)}`, signal);
  }
  send(botId: number, chatId: string, input: SendMessageInput, signal: AbortSignal) {
    return this.json<{ message: ChatMessage; clientRequestId: string }>(`${this.path(botId, chatId)}/messages`, signal, input);
  }
  async recall(botId: number, chatId: string, messageId: string, signal: AbortSignal) {
    const response = await this.fetch(`${this.path(botId, chatId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE', signal });
    return response.json() as Promise<{ chatId: string; messageId: string; recallTimeMs: number }>;
  }
  async upload(botId: number, chatId: string, file: File, signal: AbortSignal) {
    const response = await this.fetch(`${this.path(botId, chatId)}/images`, { method: 'POST', body: file,
      headers: { 'content-type': file.type }, signal });
    return response.json() as Promise<{ imageKey: string }>;
  }
  async image(botId: number, chatId: string, messageId: string, key: string, signal: AbortSignal) {
    const response = await this.fetch(`${this.path(botId, chatId)}/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(key)}`, { signal });
    if (Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw new Error('图片超过 10 MiB');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('图片内容为空');
    let size = 0;
    const parts: Uint8Array<ArrayBuffer>[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 10 * 1024 * 1024) throw new Error('图片超过 10 MiB');
        parts.push(new Uint8Array(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    return new Blob(parts, { type: response.headers.get('content-type') ?? 'image/png' });
  }
  async events(signal: AbortSignal, receive: (event: ChatEvent) => void) {
    const response = await this.fetch('/api/feishu/chat-events', { signal });
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) throw new Error('事件流响应格式错误');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let lastChunk = Date.now();
    const watchdog = setInterval(() => { if (Date.now() - lastChunk > 60_000) void reader.cancel(); }, 15_000);
    const parser = new SseParser((name, data) => {
      const event = JSON.parse(data) as ChatEvent;
      if (event && typeof event === 'object' && event.type === name) receive(event);
    });
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunk = Date.now();
        parser.push(decoder.decode(value, { stream: true }));
      }
      if (!signal.aborted) throw new Error('实时连接已断开');
    } finally { clearInterval(watchdog); await reader.cancel().catch(() => {}); }
  }
}
