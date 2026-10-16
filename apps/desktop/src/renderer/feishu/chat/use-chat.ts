import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChatApi, ChatApiError } from './api';
import { ChatCache, type ChatEntry, type RequestTicket, type Timeline } from './cache';
import type { Bot } from '../../types';
import type { BotChatConnection, ChatEvent, ChatMessage, ChatSummary, SendMessageInput } from './types';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
  });
}

export function useChat(serverUrl: string, token: string, bots: Bot[], onUnauthorized: () => void) {
  const api = useMemo(() => new ChatApi(serverUrl, token), [serverUrl, token]);
  const cache = useMemo(() => new ChatCache(), [api]);
  const recallSession = useMemo(() => ({ skipConfirmationUntil: 0, requests: new Set<string>() }), [api]);
  const version = useSyncExternalStore(cache.subscribe, cache.snapshot);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const [ready, setReady] = useState(false);
  const [streamStatus, setStreamStatus] = useState('正在连接');
  const [connections, setConnections] = useState<Record<number, BotChatConnection>>({});
  const [botId, setBotId] = useState<number>();
  const [groups, setGroups] = useState<ChatSummary[]>([]);
  const [groupToken, setGroupToken] = useState<string>();
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupError, setGroupError] = useState('');
  const [notice, setNotice] = useState('');
  const [groupHints, setGroupHints] = useState<Set<string>>(new Set());
  const groupsRef = useRef(groups); groupsRef.current = groups;
  const groupController = useRef<AbortController | undefined>(undefined);
  const readyPromise = useMemo(() => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
  }, [api]);
  const entry = cache.entries.get(cache.activeKey);

  const report = useCallback((error: unknown, target?: ChatEntry) => {
    if (error instanceof ChatApiError && error.status === 401) { unauthorized.current(); return; }
    if (error instanceof ChatApiError && error.code === 'CHAT_UNAVAILABLE' && target && cache.current(target)) {
      cache.remove(target.key); cache.changed();
    }
    setNotice(errorText(error));
  }, [cache]);

  const load = useCallback(async (target: ChatEntry, older = false, thread?: { threadId: string; rootMessageId: string }, force = false) => {
    if (!cache.current(target)) return;
    const view = cache.view(target, thread?.threadId);
    if (view.loading && !force) return;
    const last = view.pages.at(-1);
    if (older && (!last?.hasMore || !last.nextPageToken)) return;
    const replace = force || target.needsResync || !view.pages.length;
    const ticket = cache.begin(target, view, !older);
    try {
      const page = await api.history(target.chat.botId, target.chat.chatId, ticket.controller.signal, {
        threadId: thread?.threadId, rootMessageId: thread?.rootMessageId,
        pageToken: older ? last?.nextPageToken : undefined,
        snapshotEndTimeSeconds: older && !thread ? view.snapshotEndTimeSeconds : undefined
      });
      if (older && page.hasMore && page.nextPageToken === last?.nextPageToken) throw new Error('分页没有进展，请刷新');
      cache.page(ticket, page, older ? 'older' : replace ? 'replace' : 'validate');
    } catch (error) {
      if (cache.valid(ticket)) { view.error = errorText(error); report(error, target); }
    } finally { cache.finish(ticket); }
  }, [api, cache, report]);

  const refreshVisible = useCallback((filterBot?: number) => {
    const current = cache.entries.get(cache.activeKey);
    if (!current || filterBot != null && current.chat.botId !== filterBot) return;
    if (current.viewMode === 'live') void load(current, false, undefined, true);
    // Reconnection cancels all reads. A newly opened thread still needs its first page
    // even when the main timeline must stay at the user's older reading position.
    if (current.openedThread && (current.viewMode === 'live' || !cache.view(current, current.openedThread.threadId).pages.length)) {
      void load(current, false, current.openedThread, true);
    }
  }, [cache, load]);
  const refreshRef = useRef(refreshVisible);
  refreshRef.current = refreshVisible;

  const detail = useCallback(async (target: ChatEntry, id: string) => {
    if (!cache.current(target)) return;
    const controller = new AbortController();
    target.controllers.add(controller);
    try {
      const result = await api.detail(target.chat.botId, target.chat.chatId, id, controller.signal);
      if (!controller.signal.aborted) cache.detail(target, result.message);
    } catch (error) { if (!controller.signal.aborted) report(error, target); }
    finally { target.controllers.delete(controller); }
  }, [api, cache, report]);

  useEffect(() => {
    const controller = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let previousConnections: Record<number, string> = {};
    setReady(false); setStreamStatus('正在连接');
    const receive = (event: ChatEvent) => {
      if (controller.signal.aborted) return;
      if (event.type === 'ready') {
        readyPromise.resolve();
        setStreamStatus('实时连接正常');
        previousConnections = Object.fromEntries(event.connections.map((c) => [c.botId, c.status]));
        setConnections(Object.fromEntries(event.connections.map((c) => [c.botId, c])));
        cache.dirty(); refreshRef.current();
      } else if (event.type === 'message.upsert') {
        const m = event.message;
        if (m && typeof m.messageId === 'string' && typeof m.chatId === 'string' && m.botId === event.botId) {
          cache.incoming(m, event.clientRequestId);
          const key = `${m.botId}:${m.chatId}`;
          if (key !== cache.activeKey && groupsRef.current.some((g) => g.chatId === m.chatId && g.botId === m.botId)) {
            setGroupHints((values) => new Set([...values, key].slice(-1000)));
          }
        }
      } else if (event.type === 'message.recalled') cache.recall(event.botId, event.chatId, event.messageId, event.recallTimeMs);
      else if (event.type === 'bot.removed') cache.removeBot(event.botId);
      else if (event.type === 'bot.connection') {
        setConnections((values) => ({ ...values, [event.botId]: event }));
        if (event.status !== 'connected' || previousConnections[event.botId] !== 'connected') cache.dirty(event.botId);
        if (event.status === 'connected' && previousConnections[event.botId] !== 'connected') refreshRef.current(event.botId);
        previousConnections[event.botId] = event.status;
      } else if (event.type === 'message.refresh') {
        const target = [...cache.entries.values()].find((e) => e.chat.botId === event.botId
          && (event.chatId ? e.chat.chatId === event.chatId : event.messageId ? e.messages.has(event.messageId) : e.key === cache.activeKey));
        const active = cache.entries.get(cache.activeKey);
        const fallback = !event.chatId && active?.chat.botId === event.botId ? active : undefined;
        const chosen = target ?? fallback;
        if (!chosen) return;
        const key = `${chosen.key}:${target ? event.messageId : 'latest'}`;
        if (timers.has(key)) return;
        timers.set(key, setTimeout(() => {
          timers.delete(key);
          if (!cache.current(chosen)) return;
          if (target && event.messageId) void detail(chosen, event.messageId);
          else if (chosen.viewMode === 'live') refreshRef.current(event.botId);
          else { chosen.needsResync = true; cache.changed(); }
        }, 400));
      }
    };
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await api.me(controller.signal);
          if (controller.signal.aborted) return;
          setReady(true); break;
        } catch (error) {
          if (controller.signal.aborted) return;
          report(error);
          if (error instanceof ChatApiError && error.status === 401) return;
          setStreamStatus('暂时无法连接服务端，正在重试');
          await delay(5000, controller.signal);
        }
      }
      let attempt = 0;
      while (!controller.signal.aborted) {
        try {
          await api.events(controller.signal, (event) => { if (event.type === 'ready') attempt = 0; receive(event); });
        } catch (error) {
          if (controller.signal.aborted) break;
          if (error instanceof ChatApiError && error.status === 401) { report(error); break; }
          cache.dirty();
          setStreamStatus('实时连接断开，正在重连；可手动刷新');
        }
        await delay([1000, 2000, 5000, 10_000, 30_000][Math.min(attempt++, 4)] + Math.random() * 300, controller.signal);
      }
    })();
    const focus = () => {
      const current = cache.entries.get(cache.activeKey);
      if (current && (current.needsResync || Date.now() - current.lastValidatedAt > 30_000)) refreshRef.current();
    };
    window.addEventListener('focus', focus);
    return () => { controller.abort(); window.removeEventListener('focus', focus); for (const timer of timers.values()) clearTimeout(timer); cache.clear(); };
  }, [api, cache, detail, readyPromise, report]);

  useEffect(() => {
    for (const cached of cache.entries.values()) if (!bots.some((bot) => bot.id === cached.chat.botId)) cache.remove(cached.key);
    if (!bots.some((bot) => bot.id === botId)) setBotId(bots[0]?.id);
    cache.changed();
  }, [bots, botId, cache]);

  const loadGroups = useCallback(async (id: number, next?: string) => {
    groupController.current?.abort();
    const controller = new AbortController();
    groupController.current = controller;
    setGroupsLoading(true); setGroupError('');
    try {
      const result = await api.groups(id, controller.signal, next);
      if (controller.signal.aborted) return;
      setGroups((old) => next ? [...new Map([...old, ...result.items].map((g) => [g.chatId, g])).values()] : result.items);
      setGroupToken(result.hasMore && result.nextPageToken !== next ? result.nextPageToken : undefined);
    } catch (error) { if (!controller.signal.aborted) { setGroupError(errorText(error)); report(error); } }
    finally { if (!controller.signal.aborted) setGroupsLoading(false); }
  }, [api, report]);
  useEffect(() => {
    setGroups([]); setGroupToken(undefined);
    if (ready && botId != null) void loadGroups(botId);
    return () => groupController.current?.abort();
  }, [botId, ready, loadGroups]);

  const select = useCallback(async (chat: ChatSummary) => {
    setBotId(chat.botId); setNotice('');
    const target = cache.visit(chat);
    setGroupHints((values) => { const next = new Set(values); next.delete(target.key); return next; });
    const controller = new AbortController();
    target.controllers.add(controller);
    void api.chat(chat.botId, chat.chatId, controller.signal).then(({ chat: info }) => {
      if (cache.current(target)) { target.chat = info; cache.changed(); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, target); }).finally(() => target.controllers.delete(controller));
    if (!target.memberNames.size) {
      const members = new AbortController(); target.controllers.add(members);
      void (async () => {
        let next: string | undefined;
        for (let i = 0; i < 3 && !members.signal.aborted && cache.current(target); i++) {
          const result = await api.members(chat.botId, chat.chatId, members.signal, next);
          if (members.signal.aborted || !cache.current(target)) return;
          for (const item of result.items) { if (target.memberNames.size >= 300) break; if (item.id && item.name) target.memberNames.set(item.id, item.name); }
          cache.changed();
          if (!result.hasMore || !result.nextPageToken || result.nextPageToken === next) break;
          next = result.nextPageToken;
        }
      })().catch(() => {}).finally(() => target.controllers.delete(members));
    }
    await Promise.race([readyPromise.promise, delay(3000, controller.signal)]);
    if (!cache.current(target) || controller.signal.aborted) return;
    if (!target.main.pages.length || target.needsResync || Date.now() - target.lastValidatedAt > 30_000) {
      if (target.viewMode === 'live' || !target.main.pages.length) await load(target);
    }
  }, [api, cache, load, readyPromise, report]);

  const openThread = useCallback((target: ChatEntry, message: ChatMessage) => {
    if (!message.threadId) return;
    const root = { threadId: message.threadId, rootMessageId: message.rootId || message.messageId };
    target.openedThread = root;
    cache.changed();
    void load(target, false, root);
  }, [cache, load]);

  const send = useCallback(async (target: ChatEntry, input: SendMessageInput) => {
    if (!cache.current(target) || target.pending.size >= 3 && !target.pending.has(input.clientRequestId)) return;
    target.pending.set(input.clientRequestId, { input, status: 'sending' });
    cache.changed();
    try {
      const result = await api.send(target.chat.botId, target.chat.chatId, input, AbortSignal.timeout(25_000));
      if (!cache.current(target)) return;
      if (result.message.threadId && input.reply) {
        target.openedThread = { threadId: result.message.threadId, rootMessageId: result.message.rootId || input.reply.messageId };
        cache.view(target, result.message.threadId);
      }
      cache.incoming(result.message, input.clientRequestId);
      target.pending.delete(input.clientRequestId);
      target.reply = undefined;
      cache.changed();
      if (target.openedThread && input.reply) void load(target, false, target.openedThread, true);
    } catch (error) {
      if (!cache.current(target)) return;
      if (!target.pending.has(input.clientRequestId)) return; // Already confirmed by SSE.
      const uncertain = !(error instanceof ChatApiError) || error.status >= 500;
      target.pending.set(input.clientRequestId, { input, status: uncertain ? 'unknown' : 'failed', error: errorText(error) });
      cache.changed(); report(error, target);
    }
  }, [api, cache, load, report]);

  const recall = useCallback(async (target: ChatEntry, messageId: string) => {
    const key = `${target.key}:${messageId}`;
    if (!cache.current(target)) return { ok: false, error: '会话已释放，请重新选择' };
    if (target.messages.get(messageId)?.deleted) return { ok: true };
    if (recallSession.requests.has(key) || recallSession.requests.size >= 3) return { ok: false, error: '正在撤回消息，请稍候' };
    const controller = new AbortController();
    recallSession.requests.add(key); target.controllers.add(controller); cache.changed();
    try {
      const result = await api.recall(target.chat.botId, target.chat.chatId, messageId, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]));
      if (cache.current(target) && !controller.signal.aborted) cache.recall(target.chat.botId, result.chatId, result.messageId, result.recallTimeMs);
      return { ok: true };
    } catch (error) {
      if (cache.current(target) && target.messages.get(messageId)?.deleted) return { ok: true };
      const text = error instanceof ChatApiError && error.status < 500 ? errorText(error) : '撤回结果暂未确认，请刷新消息后再试';
      if (!controller.signal.aborted) report(error instanceof ChatApiError ? error : new Error(text), target);
      return { ok: false, error: text };
    } finally {
      target.controllers.delete(controller); recallSession.requests.delete(key); cache.changed();
    }
  }, [api, cache, recallSession, report]);

  return { api, cache, version, ready, streamStatus, connections, botId, setBotId: (value: number) => { setBotId(value); cache.activeKey = ''; cache.changed(); }, groups, groupToken, groupsLoading, groupError,
    entry, notice, setNotice, select, openThread, send, detail, report, groupHints, recall,
    isRecalling: (target: ChatEntry, messageId: string) => recallSession.requests.has(`${target.key}:${messageId}`),
    needsRecallConfirmation: () => Date.now() >= recallSession.skipConfirmationUntil,
    skipRecallConfirmation: () => { recallSession.skipConfirmationUntil = Date.now() + 5 * 60_000; },
    refreshGroups: () => { if (botId != null) void loadGroups(botId); },
    moreGroups: () => { if (botId != null && groupToken) void loadGroups(botId, groupToken); },
    latest: (target: ChatEntry) => { target.viewMode = 'live'; void load(target, false, undefined, true); if (target.openedThread) void load(target, false, target.openedThread, true); },
    more: (target: ChatEntry, view: Timeline) => { target.viewMode = 'history'; void load(target, true, view === target.main ? undefined : target.openedThread); }
  };
}

export type ChatController = ReturnType<typeof useChat>;
