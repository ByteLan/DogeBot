import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ChatApi, ChatApiError } from './api';
import { ChatCache, type ChatEntry, type Timeline } from './cache';
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

export function useChat(serverUrl: string, token: string, bots: Bot[], onUnauthorized: () => void, options: {
  receiveEnabled: boolean; viewing: boolean; onRefreshBots?: (signal: AbortSignal) => Promise<Bot[]>;
}) {
  const api = useMemo(() => new ChatApi(serverUrl, token), [serverUrl, token]);
  const cache = useMemo(() => new ChatCache(), [api]);
  const recallSession = useMemo(() => ({ skipConfirmationUntil: 0, requests: new Set<string>() }), [api]);
  const session = useMemo(() => new AbortController(), [api]);
  const enabled = useRef(options.receiveEnabled); enabled.current = options.receiveEnabled;
  const optionsRef = useRef(options); optionsRef.current = options;
  const needsOwnershipCheck = useRef(false);
  const version = useSyncExternalStore(cache.subscribe, cache.snapshot);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const [ready, setReady] = useState(false);
  const [streamStatus, setStreamStatus] = useState('正在连接');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [groupEpoch, setGroupEpoch] = useState(0);
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
  }, [api, options.receiveEnabled]);
  const entry = cache.entries.get(cache.activeKey);

  useEffect(() => () => { session.abort(); cache.clear(); }, [cache, session]);

  const report = useCallback((error: unknown, target?: ChatEntry) => {
    if (error instanceof Error && 'status' in error && error.status === 401) { unauthorized.current(); return; }
    if (error instanceof ChatApiError && error.code === 'CHAT_UNAVAILABLE' && target && cache.current(target)) {
      cache.remove(target.key); cache.changed();
    }
    setNotice(errorText(error));
  }, [cache]);

  const load = useCallback(async (target: ChatEntry, older = false, thread?: { threadId: string; rootMessageId: string }, force = false, manual = false) => {
    if (!cache.current(target) || !enabled.current && !manual || session.signal.aborted) return;
    const view = cache.view(target, thread?.threadId);
    if (view.loading && !force) return;
    const last = view.pages.at(-1);
    if (older && (!last?.hasMore || !last.nextPageToken)) return;
    const replace = force || view.needsResync || !view.pages.length;
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
  }, [api, cache, report, session]);

  const refreshVisible = useCallback((filterBot?: number) => {
    if (!enabled.current) return;
    const current = cache.entries.get(cache.activeKey);
    if (!current || filterBot != null && current.chat.botId !== filterBot) return;
    if (current.viewMode === 'live') void load(current, false, undefined, true);
    // Reconnection cancels all reads. A newly opened thread still needs its first page
    // even when the main timeline must stay at the user's older reading position.
    if (current.openedThread && (cache.view(current, current.openedThread.threadId).viewMode === 'live' || !cache.view(current, current.openedThread.threadId).pages.length)) {
      void load(current, false, current.openedThread, true);
    }
  }, [cache, load]);
  const refreshRef = useRef(refreshVisible);
  refreshRef.current = refreshVisible;

  const detail = useCallback(async (target: ChatEntry, id: string) => {
    if (!cache.current(target) || !enabled.current) return;
    const controller = cache.read(target);
    try {
      const result = await api.detail(target.chat.botId, target.chat.chatId, id, controller.signal);
      if (!controller.signal.aborted && cache.current(target)) {
        cache.detail(target, result.message);
        return target.messages.get(id);
      }
    } catch (error) { if (!controller.signal.aborted) report(error, target); }
    finally { cache.finishRead(controller); }
  }, [api, cache, report]);

  useEffect(() => {
    setSyncing(false); setSyncError(''); setGroupEpoch(0);
    if (!options.receiveEnabled) {
      needsOwnershipCheck.current = true;
      cache.dirty(); setGroupsLoading(false); setStreamStatus('已暂停收取');
      return;
    }
    const controller = new AbortController();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let previousConnections: Record<number, string> = {};
    let usedFallback = false;
    setReady(false); setStreamStatus('正在连接');
    const synchronize = async () => {
      cache.dirty();
      const read = cache.read();
      let target: ChatEntry | undefined;
      setSyncing(true); setSyncError('');
      try {
        if (needsOwnershipCheck.current && optionsRef.current.onRefreshBots) {
          const fresh = await optionsRef.current.onRefreshBots(read.signal);
          if (read.signal.aborted) return;
          for (const cached of cache.entries.values()) if (!fresh.some((bot) => bot.id === cached.chat.botId)) cache.remove(cached.key);
          cache.changed();
        }
        if (read.signal.aborted) return;
        needsOwnershipCheck.current = true;
        setGroupEpoch((value) => value + 1);
        const current = cache.entries.get(cache.activeKey);
        if (current) {
          target = current;
          const result = await api.chat(current.chat.botId, current.chat.chatId, read.signal);
          if (read.signal.aborted || !cache.current(current)) return;
          current.chat = result.chat; cache.changed();
          if (cache.activeKey === current.key) refreshRef.current();
        }
      } catch (error) {
        if (!read.signal.aborted) {
          if (!target || cache.activeKey === target.key) setSyncError(errorText(error));
          report(error, target);
        }
      } finally {
        if (!read.signal.aborted && !controller.signal.aborted) setSyncing(false);
        read.abort(); cache.finishRead(read);
      }
    };
    const receive = (event: ChatEvent) => {
      if (controller.signal.aborted || !enabled.current) return;
      if (event.type === 'ready') {
        readyPromise.resolve();
        setStreamStatus('实时连接正常');
        previousConnections = Object.fromEntries(event.connections.map((c) => [c.botId, c.status]));
        setConnections(Object.fromEntries(event.connections.map((c) => [c.botId, c])));
        void synchronize();
      } else if (event.type === 'message.upsert') {
        const m = event.message;
        if (m && typeof m.messageId === 'string' && typeof m.chatId === 'string' && m.botId === event.botId) {
          cache.incoming(m, event.clientRequestId);
          const key = `${m.botId}:${m.chatId}`;
          const current = cache.entries.get(cache.activeKey);
          if ((key !== cache.activeKey || !optionsRef.current.viewing || current?.viewMode === 'history')
            && groupsRef.current.some((g) => g.chatId === m.chatId && g.botId === m.botId)) {
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
          if (!enabled.current || controller.signal.aborted || !cache.current(chosen)) return;
          if (target && event.messageId) void detail(chosen, event.messageId);
          else if (chosen.viewMode === 'live') refreshRef.current(event.botId);
          else { chosen.needsResync = true; chosen.main.needsResync = true; cache.changed(); }
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
          setSyncing(false);
          setStreamStatus('实时连接断开，正在重连；可手动刷新');
          if (!usedFallback) { usedFallback = true; setGroupEpoch((value) => value + 1); }
        }
        await delay([1000, 2000, 5000, 10_000, 30_000][Math.min(attempt++, 4)] + Math.random() * 300, controller.signal);
      }
    })();
    const focus = () => {
      if (!enabled.current) return;
      const current = cache.entries.get(cache.activeKey);
      if (current && (current.needsResync || current.openedThread && cache.view(current, current.openedThread.threadId).needsResync
        || Date.now() - current.lastValidatedAt > 30_000)) refreshRef.current();
    };
    window.addEventListener('focus', focus);
    return () => {
      controller.abort(); window.removeEventListener('focus', focus);
      for (const timer of timers.values()) clearTimeout(timer);
      cache.dirty();
    };
  }, [api, cache, detail, readyPromise, report, options.receiveEnabled]);

  useEffect(() => {
    for (const cached of cache.entries.values()) if (!bots.some((bot) => bot.id === cached.chat.botId)) cache.remove(cached.key);
    if (!bots.some((bot) => bot.id === botId)) setBotId(bots[0]?.id);
    cache.changed();
  }, [bots, botId, cache]);

  const loadGroups = useCallback(async (id: number, next?: string, manual = false) => {
    if (!enabled.current && !manual) return;
    groupController.current?.abort();
    const controller = cache.read();
    groupController.current = controller;
    setGroupsLoading(true); setGroupError('');
    try {
      const result = await api.groups(id, controller.signal, next);
      if (controller.signal.aborted) return;
      setGroups((old) => next ? [...new Map([...old, ...result.items].map((g) => [g.chatId, g])).values()] : result.items);
      setGroupToken(result.hasMore && result.nextPageToken !== next ? result.nextPageToken : undefined);
    } catch (error) { if (!controller.signal.aborted) { setGroupError(errorText(error)); report(error); } }
    finally {
      cache.finishRead(controller);
      if (groupController.current === controller) setGroupsLoading(false);
    }
  }, [api, cache, report]);
  useEffect(() => {
    if (ready && options.receiveEnabled && groupEpoch > 0 && botId != null && bots.some((bot) => bot.id === botId)) void loadGroups(botId);
    return () => groupController.current?.abort();
  }, [botId, bots, ready, groupEpoch, options.receiveEnabled, loadGroups]);
  useEffect(() => { setGroups([]); setGroupToken(undefined); }, [botId]);

  const select = useCallback(async (chat: ChatSummary) => {
    if (!enabled.current) return;
    setBotId(chat.botId); setNotice('');
    const target = cache.visit(chat);
    setGroupHints((values) => { const next = new Set(values); next.delete(target.key); return next; });
    const controller = cache.read(target);
    void api.chat(chat.botId, chat.chatId, controller.signal).then(({ chat: info }) => {
      if (!controller.signal.aborted && cache.current(target)) { target.chat = info; cache.changed(); }
    }).catch((error: unknown) => { if (!controller.signal.aborted) report(error, target); });
    if (!target.memberNames.size) {
      const members = cache.read(target);
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
      })().catch(() => {}).finally(() => cache.finishRead(members));
    }
    await Promise.race([readyPromise.promise, delay(3000, controller.signal)]);
    if (cache.current(target) && !controller.signal.aborted && enabled.current) {
      if (!target.main.pages.length || target.main.needsResync || Date.now() - target.lastValidatedAt > 30_000) {
        if (target.viewMode === 'live' || !target.main.pages.length) await load(target);
      }
    }
    controller.abort(); cache.finishRead(controller);
  }, [api, cache, load, readyPromise, report]);

  const ensureMessage = useCallback(async (target: ChatEntry, id: string) => {
    if (!enabled.current || !cache.current(target)) return;
    const message = target.unverifiedIds.has(id) ? await detail(target, id) : target.messages.get(id);
    if (message?.deleted) { setNotice('这条消息已撤回，请选择其他消息'); return; }
    return message;
  }, [cache, detail]);

  const openThread = useCallback(async (target: ChatEntry, input: ChatMessage) => {
    const message = await ensureMessage(target, input.messageId);
    if (!message || !cache.current(target) || !enabled.current) return;
    if (!message.threadId) return;
    const root = { threadId: message.threadId, rootMessageId: message.rootId || message.messageId };
    target.openedThread = root;
    cache.changed();
    void load(target, false, root);
  }, [cache, ensureMessage, load]);

  const send = useCallback(async (target: ChatEntry, input: SendMessageInput) => {
    if (!cache.current(target) || target.pending.size >= 3 && !target.pending.has(input.clientRequestId)) return;
    target.pending.set(input.clientRequestId, { input, status: 'sending' });
    cache.changed();
    const controller = new AbortController(); target.controllers.add(controller);
    const signal = AbortSignal.any([controller.signal, session.signal, AbortSignal.timeout(25_000)]);
    try {
      if (input.reply && target.unverifiedIds.has(input.reply.messageId)) {
        const checked = await api.detail(target.chat.botId, target.chat.chatId, input.reply.messageId, signal);
        if (signal.aborted || !cache.current(target)) return;
        cache.detail(target, checked.message);
        if (target.messages.get(input.reply.messageId)?.deleted) throw new ChatApiError('引用消息已撤回，请取消引用后发送', 400);
      }
      const result = await api.send(target.chat.botId, target.chat.chatId, input, signal);
      if (!cache.current(target) || controller.signal.aborted || session.signal.aborted) return;
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
    finally { target.controllers.delete(controller); }
  }, [api, cache, load, report, session]);

  const recall = useCallback(async (target: ChatEntry, messageId: string) => {
    const key = `${target.key}:${messageId}`;
    if (!cache.current(target)) return { ok: false, error: '会话已释放，请重新选择' };
    if (target.messages.get(messageId)?.deleted) return { ok: true };
    if (recallSession.requests.has(key) || recallSession.requests.size >= 3) return { ok: false, error: '正在撤回消息，请稍候' };
    const controller = new AbortController();
    recallSession.requests.add(key); target.controllers.add(controller); cache.changed();
    try {
      const signal = AbortSignal.any([controller.signal, session.signal, AbortSignal.timeout(25_000)]);
      if (target.unverifiedIds.has(messageId)) {
        const checked = await api.detail(target.chat.botId, target.chat.chatId, messageId, signal);
        if (signal.aborted || !cache.current(target)) return { ok: false, error: '会话已释放' };
        cache.detail(target, checked.message);
        if (target.messages.get(messageId)?.deleted) return { ok: true };
      }
      const result = await api.recall(target.chat.botId, target.chat.chatId, messageId, signal);
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
  }, [api, cache, recallSession, report, session]);

  const latest = (target: ChatEntry, view = target.main) => {
    setSyncError('');
    if (view === target.main) target.viewMode = 'live';
    view.viewMode = 'live';
    void load(target, false, view === target.main ? undefined : target.openedThread, true, true);
  };
  useEffect(() => {
    if (!options.viewing || !entry || entry.viewMode !== 'live' || entry.main.needsResync) return;
    setGroupHints((values) => {
      if (!values.has(entry.key)) return values;
      const next = new Set(values); next.delete(entry.key); return next;
    });
  }, [options.viewing, entry, version]);

  return { api, cache, version, ready, streamStatus, syncing, syncError, receiveEnabled: options.receiveEnabled, viewing: options.viewing,
    connections, botId, setBotId: (value: number) => { setBotId(value); cache.activeKey = ''; cache.changed(); }, groups, groupToken, groupsLoading, groupError,
    entry, notice, setNotice, select, openThread, send, detail, ensureMessage, report, groupHints, recall,
    isRecalling: (target: ChatEntry, messageId: string) => recallSession.requests.has(`${target.key}:${messageId}`),
    needsRecallConfirmation: () => Date.now() >= recallSession.skipConfirmationUntil,
    skipRecallConfirmation: () => { recallSession.skipConfirmationUntil = Date.now() + 5 * 60_000; },
    refreshGroups: () => { if (botId != null) void loadGroups(botId, undefined, true); },
    moreGroups: () => { if (botId != null && groupToken) void loadGroups(botId, groupToken); },
    latest,
    more: (target: ChatEntry, view: Timeline) => {
      if (view === target.main) target.viewMode = 'history';
      view.viewMode = 'history';
      void load(target, true, view === target.main ? undefined : target.openedThread, false, true);
    }
  };
}

export type ChatController = ReturnType<typeof useChat>;
