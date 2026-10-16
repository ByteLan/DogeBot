import type { ChatMessage, ChatSummary, HistoryPage, SendMessageInput } from './types';

export const MAX_CACHED_CHATS = 10;
export const MAX_MESSAGES_PER_CHAT = 300;
export const MAX_MESSAGE_CACHE_BYTES = 16 * 1024 * 1024;
export const MAX_MEDIA_CACHE_BYTES = 16 * 1024 * 1024;

export type CachedPage = { ids: string[]; nextPageToken?: string; hasMore: boolean };
export type Timeline = {
  pages: CachedPage[];
  head: string[];
  generation: number;
  loading: boolean;
  error: string;
  snapshotEndTimeSeconds?: string;
  newerTruncated: boolean;
};
export type PendingSend = { input: SendMessageInput; status: 'sending' | 'failed' | 'unknown'; error?: string };
export type ChatEntry = {
  key: string; chat: ChatSummary; generation: number; lastVisited: number;
  messages: Map<string, ChatMessage>;
  revisions: Map<string, number>;
  tombstones: Map<string, number>;
  main: Timeline;
  threads: Map<string, Timeline>;
  openedThread?: { threadId: string; rootMessageId: string };
  controllers: Set<AbortController>;
  needsResync: boolean; lastValidatedAt: number; revision: number;
  viewMode: 'live' | 'history'; newMessages: number;
  draft: string; pending: Map<string, PendingSend>;
  reply?: { messageId: string; mode: 'chat' | 'thread' };
  detailIds: string[];
  memberNames: Map<string, string>;
  scrollAnchors: Map<string, { id: string; offset: number }>;
};
export type RequestTicket = { key: string; generation: number; queryGeneration: number; revision: number; controller: AbortController; timeline: Timeline };
const timeline = (): Timeline => ({ pages: [], head: [], generation: 0, loading: false, error: '', newerTruncated: false });
export const chatKey = (botId: number, chatId: string) => `${botId}:${chatId}`;
export const isThreadReply = (m: ChatMessage) => Boolean(m.threadId && m.parentId && m.rootId !== m.messageId);
const encode = new TextEncoder();

export class ChatCache {
  readonly entries = new Map<string, ChatEntry>();
  readonly media = new Map<string, { owner: string; url: string; bytes: number }>();
  activeKey = '';
  private nextGeneration = 0;
  private visits = 0;
  private version = 0;
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.version;
  changed = () => { this.enforce(); this.version++; for (const listener of this.listeners) listener(); };

  visit(chat: ChatSummary) {
    const key = chatKey(chat.botId, chat.chatId);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, chat, generation: ++this.nextGeneration, lastVisited: 0, messages: new Map(), revisions: new Map(), tombstones: new Map(),
        main: timeline(), threads: new Map(), controllers: new Set(), needsResync: false, lastValidatedAt: 0,
        revision: 0, viewMode: 'live', newMessages: 0, draft: '', pending: new Map(), detailIds: [], memberNames: new Map(), scrollAnchors: new Map() };
      this.entries.set(key, entry);
    }
    entry.lastVisited = ++this.visits;
    this.activeKey = key;
    this.changed();
    return entry;
  }
  current(entry: ChatEntry) { return this.entries.get(entry.key)?.generation === entry.generation; }
  view(entry: ChatEntry, threadId?: string) {
    if (!threadId) return entry.main;
    let value = entry.threads.get(threadId);
    if (!value) { value = timeline(); entry.threads.set(threadId, value); }
    return value;
  }
  ids(view: Timeline) { return [...new Set([...view.pages.flatMap((page) => page.ids), ...view.head])]; }
  messages(entry: ChatEntry, view = entry.main) {
    const ids = view.newerTruncated ? [...new Set(view.pages.flatMap((p) => p.ids))] : this.ids(view);
    return ids.map((id) => entry.messages.get(id)).filter((m): m is ChatMessage => Boolean(m))
      .sort((a, b) => a.createTimeMs - b.createTimeMs || a.messageId.localeCompare(b.messageId));
  }
  begin(entry: ChatEntry, view: Timeline, reset: boolean): RequestTicket {
    if (reset) view.generation++;
    const controller = new AbortController();
    entry.controllers.add(controller);
    view.loading = true;
    view.error = '';
    this.changed();
    return { key: entry.key, generation: entry.generation, queryGeneration: view.generation, revision: entry.revision, controller, timeline: view };
  }
  valid(ticket: RequestTicket) {
    const entry = this.entries.get(ticket.key);
    return entry?.generation === ticket.generation && ticket.timeline.generation === ticket.queryGeneration && !ticket.controller.signal.aborted ? entry : undefined;
  }
  finish(ticket: RequestTicket) {
    const entry = this.entries.get(ticket.key);
    entry?.controllers.delete(ticket.controller);
    if (this.valid(ticket)) { ticket.timeline.loading = false; this.changed(); }
  }
  merge(entry: ChatEntry, message: ChatMessage, requestRevision?: number) {
    if (message.botId !== entry.chat.botId || message.chatId !== entry.chat.chatId) return;
    const id = message.messageId;
    const previous = entry.messages.get(id);
    if (entry.tombstones.has(id) || previous?.deleted) message = { ...message, deleted: true, content: {}, mentions: [] };
    else if (previous) {
      const newer = (previous.updateTimeMs ?? previous.createTimeMs) > (message.updateTimeMs ?? message.createTimeMs);
      const raced = requestRevision != null && (entry.revisions.get(id) ?? 0) > requestRevision
        && (message.updateTimeMs ?? 0) <= (previous.updateTimeMs ?? previous.createTimeMs);
      if (newer || raced) return;
      message = { ...message, createTimeMs: message.createTimeMs || previous.createTimeMs,
        rootId: message.rootId || previous.rootId, parentId: message.parentId || previous.parentId,
        threadId: message.threadId || previous.threadId,
        sender: { ...message.sender, id: message.sender.id || previous.sender.id,
          displayName: message.sender.displayName || previous.sender.displayName },
        content: message.deleted ? {} : message.contentState === 'unavailable' ? previous.content : message.content,
        contentState: message.contentState === 'unavailable' && !message.deleted ? previous.contentState : message.contentState };
    }
    entry.messages.set(id, message);
    entry.revisions.set(id, ++entry.revision);
  }
  page(ticket: RequestTicket, result: HistoryPage, mode: 'replace' | 'older' | 'validate') {
    const entry = this.valid(ticket);
    if (!entry) return;
    const view = ticket.timeline;
    const overlap = result.items.some((m) => entry.messages.has(m.messageId) && this.ids(view).includes(m.messageId));
    if (mode === 'validate' && !overlap && this.ids(view).length) {
      if (entry.viewMode === 'history') { entry.needsResync = true; view.newerTruncated = true; entry.newMessages++; this.changed(); return; }
      mode = 'replace';
    }
    const arrived = this.ids(view).filter((id) => (entry.revisions.get(id) ?? 0) > ticket.revision);
    for (const m of result.items) this.merge(entry, m, ticket.revision);
    const page = { ids: result.items.map((m) => m.messageId), hasMore: result.hasMore, nextPageToken: result.nextPageToken };
    if (mode === 'older') view.pages.push(page);
    else if (mode === 'replace') {
      view.pages = [page];
      view.head = arrived.filter((id) => !page.ids.includes(id));
      view.newerTruncated = false;
      view.snapshotEndTimeSeconds = result.snapshotEndTimeSeconds;
    } else {
      const oldest = Math.min(...this.messages(entry, view).map((m) => m.createTimeMs));
      view.head = [...new Set([...view.head, ...result.items.filter((m) => m.createTimeMs >= oldest).map((m) => m.messageId)])];
    }
    const paged = new Set(view.pages.flatMap((p) => p.ids));
    view.head = view.head.filter((id) => !paged.has(id));
    if (view === entry.main && mode !== 'older') { entry.needsResync = false; entry.lastValidatedAt = Date.now(); entry.newMessages = 0; }
    this.trim(entry, view, mode === 'older');
    this.changed();
  }
  incoming(message: ChatMessage, requestId?: string) {
    const entry = this.entries.get(chatKey(message.botId, message.chatId));
    if (!entry) return;
    if (requestId) entry.pending.delete(requestId);
    const existing = entry.messages.has(message.messageId);
    if (isThreadReply(message)) {
      const root = entry.messages.get(message.rootId || message.parentId || '');
      if (root && !root.threadId) this.merge(entry, { ...root, threadId: message.threadId });
    }
    const view = isThreadReply(message) ? entry.threads.get(message.threadId!) : entry.main;
    if (view && (!view.newerTruncated || view.loading || existing)) {
      this.merge(entry, message);
      if (!this.ids(view).includes(message.messageId)) view.head.push(message.messageId);
      this.trim(entry, view, false);
    }
    if (!existing && (entry.key !== this.activeKey || entry.viewMode === 'history' || !view)) entry.newMessages = Math.min(999, entry.newMessages + 1);
    this.changed();
  }
  recall(botId: number, chatId: string | undefined, id: string, time: number) {
    for (const entry of this.entries.values()) {
      if (entry.chat.botId !== botId || (chatId ? entry.chat.chatId !== chatId : !entry.messages.has(id))) continue;
      this.releaseMedia(entry.key, id);
      if (entry.reply?.messageId === id) entry.reply = undefined;
      if (!entry.messages.has(id) && !entry.controllers.size) continue;
      entry.tombstones.set(id, time);
      if (entry.tombstones.size > 300) {
        // Do not forget a tombstone while an older response can still revive it.
        for (const controller of entry.controllers) controller.abort();
        entry.controllers.clear(); entry.needsResync = true;
        for (const view of [entry.main, ...entry.threads.values()]) { view.generation++; view.loading = false; }
        entry.tombstones.delete(entry.tombstones.keys().next().value!);
      }
      const m = entry.messages.get(id);
      if (m) this.merge(entry, { ...m, deleted: true, content: {}, mentions: [], updateTimeMs: time });
    }
    this.changed();
  }
  dirty(botId?: number) {
    for (const entry of this.entries.values()) {
      if (botId != null && entry.chat.botId !== botId) continue;
      entry.needsResync = true;
      for (const controller of entry.controllers) controller.abort();
      entry.controllers.clear();
      for (const view of [entry.main, ...entry.threads.values()]) { view.generation++; view.loading = false; view.newerTruncated = true; }
    }
    this.changed();
  }
  detail(entry: ChatEntry, message: ChatMessage) {
    if (!this.current(entry)) return;
    this.merge(entry, message);
    entry.detailIds = [...entry.detailIds.filter((id) => id !== message.messageId), message.messageId].slice(-10);
    this.trim(entry, entry.main, false);
    this.changed();
  }
  private collect(entry: ChatEntry) {
    const keep = new Set([...[entry.main, ...entry.threads.values()].flatMap((v) => this.ids(v)), ...entry.detailIds,
      entry.openedThread?.rootMessageId ?? '', entry.reply?.messageId ?? '']);
    for (const id of entry.messages.keys()) if (!keep.has(id)) {
      entry.messages.delete(id); entry.revisions.delete(id); this.releaseMedia(entry.key, id);
    }
  }
  private trim(entry: ChatEntry, preferred: Timeline, older: boolean) {
    this.collect(entry);
    const views = [entry.main, ...entry.threads.values()];
    while (entry.messages.size > MAX_MESSAGES_PER_CHAT) {
      const opened = entry.openedThread ? entry.threads.get(entry.openedThread.threadId) : undefined;
      const victim = views.find((v) => v !== preferred && v !== entry.main && v !== opened && v.pages.length > 0)
        ?? views.find((v) => v !== preferred && v.pages.length > 1) ?? views.find((v) => v.pages.length > 1);
      if (victim) {
        if (victim === preferred && older) { victim.pages.shift(); victim.head = []; victim.newerTruncated = true; }
        else victim.pages.pop();
      } else {
        const head = views.find((v) => v.head.length > 0);
        if (head) head.head.shift();
        else if (entry.detailIds.length) entry.detailIds.shift();
        else break;
      }
      this.collect(entry);
    }
    for (const [id, value] of entry.threads) if (id !== entry.openedThread?.threadId && !this.ids(value).length) {
      entry.threads.delete(id); entry.scrollAnchors.delete(id);
    }
  }
  private size(entry: ChatEntry) {
    return encode.encode(JSON.stringify([...entry.messages.values()])).byteLength + entry.draft.length * 2
      + encode.encode(JSON.stringify([...entry.pending.values()])).byteLength + entry.tombstones.size * 100;
  }
  private enforce() {
    const bytes = () => [...this.entries.values()].reduce((n, e) => n + this.size(e), 0);
    while (this.entries.size > MAX_CACHED_CHATS || bytes() > MAX_MESSAGE_CACHE_BYTES) {
      const candidate = [...this.entries.values()].filter((e) => e.key !== this.activeKey).sort((a, b) => a.lastVisited - b.lastVisited)[0];
      if (candidate) this.remove(candidate.key);
      else {
        const active = this.entries.get(this.activeKey);
        if (!active || this.size(active) <= MAX_MESSAGE_CACHE_BYTES) break;
        const views = [active.main, ...active.threads.values()];
        const opened = active.openedThread ? active.threads.get(active.openedThread.threadId) : undefined;
        const victim = views.find((v) => v !== active.main && v !== opened && v.pages.length > 0) ?? views.find((v) => v.pages.length > 1);
        if (victim) {
          if (victim === active.main && active.viewMode === 'history') { victim.pages.shift(); victim.head = []; victim.newerTruncated = true; }
          else victim.pages.pop();
          this.collect(active);
          continue;
        }
        const head = views.find((v) => v.head.length > 50);
        if (head) { head.head.splice(0, 50); this.collect(active); continue; }
        for (const [id, m] of active.messages) active.messages.set(id, { ...m, content: {}, contentState: 'summary' });
        this.releaseMedia(active.key);
        break;
      }
    }
  }
  mediaUrl(key: string) {
    const item = this.media.get(key);
    if (!item) return undefined;
    this.media.delete(key); this.media.set(key, item);
    return item.url;
  }
  putMedia(entry: ChatEntry, key: string, blob: Blob) {
    if (!this.current(entry) || blob.size > MAX_MEDIA_CACHE_BYTES) return undefined;
    const old = this.media.get(key);
    if (old) URL.revokeObjectURL(old.url);
    this.media.delete(key);
    while ([...this.media.values()].reduce((n, v) => n + v.bytes, 0) + blob.size > MAX_MEDIA_CACHE_BYTES) {
      const first = this.media.entries().next().value;
      if (!first) break;
      URL.revokeObjectURL(first[1].url); this.media.delete(first[0]);
    }
    const url = URL.createObjectURL(blob);
    this.media.set(key, { owner: entry.key, url, bytes: blob.size });
    return url;
  }
  private releaseMedia(owner: string, messageId?: string) {
    for (const [key, image] of this.media) if (image.owner === owner && (!messageId || key.includes(`:${messageId}:`))) {
      URL.revokeObjectURL(image.url); this.media.delete(key);
    }
  }
  remove(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    for (const controller of entry.controllers) controller.abort();
    this.releaseMedia(key);
    this.entries.delete(key);
    // Async closures can retain the entry until a write finishes. Release its data now.
    entry.messages.clear(); entry.revisions.clear(); entry.tombstones.clear();
    for (const view of [entry.main, ...entry.threads.values()]) { view.pages = []; view.head = []; }
    entry.threads.clear(); entry.controllers.clear(); entry.pending.clear(); entry.memberNames.clear(); entry.scrollAnchors.clear();
    entry.detailIds = []; entry.draft = ''; entry.reply = undefined; entry.openedThread = undefined;
    if (this.activeKey === key) this.activeKey = '';
  }
  removeBot(botId: number) { for (const e of this.entries.values()) if (e.chat.botId === botId) this.remove(e.key); this.changed(); }
  clear() { for (const key of this.entries.keys()) this.remove(key); this.changed(); }
}
