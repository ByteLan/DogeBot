import React, { useEffect, useRef, useState } from 'react';
import type { Bot } from '../../types';
import type { ChatMessage, SendMessageInput } from './types';
import type { ChatEntry, Timeline } from './cache';
import { MAX_CACHED_CHATS } from './cache';
import { useChat, type ChatController } from './use-chat';
import './chat.css';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function messageText(message: ChatMessage) {
  let nodes = 0;
  const read = (value: unknown, depth: number): string => {
    if (++nodes > 200 || depth > 10) return '';
    if (typeof value === 'string') return value.slice(0, 4000);
    if (Array.isArray(value)) return value.map((v) => read(v, depth + 1)).filter(Boolean).join('\n');
    const item = object(value);
    if (item.tag === 'person_list' && Array.isArray(item.persons)) return `成员列表（${item.persons.length} 人）`;
    if (item.tag === 'at') return `@${String(item.user_name || item.name || item.user_id || '')}`;
    if (typeof item.text === 'string') return item.text;
    return ['title', 'content', 'elements', 'body', 'zh_cn', 'en_us', 'text'].map((key) => read(item[key], depth + 1)).filter(Boolean).join('\n');
  };
  let text = read(message.content, 0).slice(0, 4000);
  for (const mention of message.mentions) if (mention.key) text = text.split(mention.key).join(`@${mention.name || mention.id}`);
  text = text.replace(/<at\b[^>]*>(.*?)<\/at>/g, (_all, name: string) => `@${name || '成员'}`);
  return text || (message.contentState === 'summary' ? '内容过大，请在飞书中查看' : `[${({ image: '图片', file: '文件', audio: '语音', media: '视频', sticker: '表情包', interactive: '卡片' } as Record<string, string>)[message.msgType] ?? message.msgType}]`);
}

function imageKeys(value: unknown) {
  const keys = new Set<string>();
  let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > 200 || depth > 8 || keys.size >= 3) return;
    if (Array.isArray(v)) { for (const child of v) visit(child, depth + 1); return; }
    const item = object(v);
    if (typeof item.image_key === 'string') keys.add(item.image_key);
    for (const child of Object.values(item)) if (typeof child === 'object') visit(child, depth + 1);
  };
  visit(value, 0);
  return [...keys];
}

function MessageImage({ controller, entry, message, imageKey }: { controller: ChatController; entry: ChatEntry; message: ChatMessage; imageKey: string }) {
  const key = `${entry.key}:${message.messageId}:${imageKey}`;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const url = controller.cache.media.get(key)?.url;
  const load = async () => {
    if (request.current || controller.cache.mediaUrl(key)) return;
    const abort = new AbortController();
    request.current = abort; entry.controllers.add(abort);
    setLoading(true); setError('');
    try {
      const blob = await controller.api.image(entry.chat.botId, entry.chat.chatId, message.messageId, imageKey, abort.signal);
      if (!abort.signal.aborted && !entry.messages.get(message.messageId)?.deleted) {
        controller.cache.putMedia(entry, key, blob); controller.cache.changed();
      }
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally { entry.controllers.delete(abort); request.current = undefined; if (mounted.current) setLoading(false); }
  };
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    mounted.current = true;
    const observer = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) { observer.disconnect(); void loadRef.current(); }
    });
    if (host.current) observer.observe(host.current);
    return () => { mounted.current = false; observer.disconnect(); request.current?.abort(); };
  }, [key]);
  return <div ref={host} className="chat-message-image">
    {url ? <button type="button" className="chat-image-button" onClick={() => setExpanded(true)}><img src={url} alt="消息图片" loading="lazy" onError={() => setError('预览已释放，请重新加载')} /></button>
      : <button type="button" disabled={loading} onClick={() => void load()}>{loading ? '加载图片…' : error || '点击加载图片'}</button>}
    {expanded && url && <div className="chat-image-overlay" role="dialog" aria-label="图片预览" onClick={() => setExpanded(false)}>
      <button type="button" onClick={() => setExpanded(false)}>关闭预览</button><img src={url} alt="消息图片大图" />
    </div>}
  </div>;
}

function MessageItem({ controller, entry, message, bot, onReference }: {
  controller: ChatController; entry: ChatEntry; message: ChatMessage; bot?: Bot; onReference: (id: string) => void;
}) {
  const self = message.sender.id === bot?.appId || message.sender.id === bot?.botOpenId;
  const label = self ? bot?.botName || bot?.name : message.sender.displayName || entry.memberNames.get(message.sender.id) || (message.sender.type === 'app' ? `机器人 ${message.sender.id}` : message.sender.id || '未知成员');
  const quote = (mode: 'chat' | 'thread') => {
    entry.reply = { messageId: message.messageId, mode }; controller.cache.changed();
  };
  return <article className={`chat-message ${self ? 'chat-message-self' : ''}`} data-message-id={message.messageId}>
    <header><strong>{label}</strong><time>{message.createTimeMs ? new Date(message.createTimeMs).toLocaleString('zh-CN', { hour12: false }) : '时间待同步'}</time></header>
    <div className="chat-message-body">
      {message.deleted ? <span className="chat-muted">消息已撤回</span> : <>
        {message.parentId && <button className="chat-reference" type="button" onClick={() => onReference(message.parentId!)}>查看引用消息</button>}
        {(message.msgType !== 'image' || message.contentState !== 'full') && <div className="chat-message-text">{messageText(message).split(/(https?:\/\/[^\s<>]+)/g).map((part, i) => /^https?:\/\//.test(part)
          ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part)}</div>}
        {imageKeys(message.content).map((key) => <MessageImage key={key} controller={controller} entry={entry} message={message} imageKey={key} />)}
        <div className="chat-message-actions">
          <button type="button" onClick={() => quote(message.threadId || entry.chat.chatMode === 'topic' ? 'thread' : 'chat')}>引用回复</button>
          <button type="button" onClick={() => quote('thread')}>话题回复</button>
          {message.threadId && <button type="button" onClick={() => controller.openThread(entry, message)}>查看话题</button>}
          {message.msgType !== 'image' && <button type="button" onClick={() => {
            if (!navigator.clipboard) { controller.setNotice('当前环境无法访问剪贴板'); return; }
            void navigator.clipboard.writeText(messageText(message)).catch(() => controller.setNotice('复制失败'));
          }}>复制</button>}
        </div>
      </>}
    </div>
  </article>;
}

function MessageList({ controller, entry, view, bot, thread = false }: {
  controller: ChatController; entry: ChatEntry; view: Timeline; bot?: Bot; thread?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const contentHost = useRef<HTMLDivElement>(null);
  const scrollKey = thread ? entry.openedThread?.threadId || 'main' : 'main';
  const follow = useRef(entry.viewMode === 'live');
  const anchor = useRef<{ id: string; offset: number } | undefined>(entry.viewMode === 'history' ? entry.scrollAnchors.get(scrollKey) : undefined);
  const [reference, setReference] = useState<string>();
  const messages = controller.cache.messages(entry, view);
  const last = view.pages.at(-1);
  const signature = messages.map((m) => m.messageId).join(',');
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!thread && entry.viewMode === 'live' && view.loading) { follow.current = true; anchor.current = undefined; }
    if (anchor.current) {
      const found = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.dataset.messageId === anchor.current?.id);
      if (found) element.scrollTop += found.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
      if (!view.loading) anchor.current = undefined;
    } else if (follow.current && (!view.newerTruncated || view.loading)) element.scrollTop = element.scrollHeight;
  }, [signature, view.loading, view.newerTruncated, view.generation]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const element = host.current;
      if (!element || anchor.current) return;
      if (follow.current) element.scrollTop = element.scrollHeight;
      else {
        const saved = entry.scrollAnchors.get(scrollKey);
        const item = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((node) => node.dataset.messageId === saved?.id);
        if (item && saved) element.scrollTop += item.getBoundingClientRect().top - element.getBoundingClientRect().top - saved.offset;
      }
    });
    if (contentHost.current) observer.observe(contentHost.current);
    return () => observer.disconnect();
  }, [entry, scrollKey]);
  const older = () => {
    const element = host.current;
    if (element) {
      const top = element.getBoundingClientRect().top;
      const first = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.getBoundingClientRect().bottom >= top);
      if (first?.dataset.messageId) anchor.current = { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top };
    }
    follow.current = false; controller.more(entry, view);
  };
  const showReference = (id: string) => {
    const existing = [...host.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []].find((item) => item.dataset.messageId === id);
    if (existing) { existing.scrollIntoView({ block: 'center' }); return; }
    setReference(id); void controller.detail(entry, id);
  };
  return <>
    {view.error && <div className="chat-error" role="alert">{view.error}</div>}
    {reference && <aside className="chat-quoted-detail"><button type="button" onClick={() => setReference(undefined)}>关闭引用</button>
      {entry.messages.has(reference) ? messageText(entry.messages.get(reference)!) : '正在读取引用消息…'}
    </aside>}
    <div className="chat-message-list" ref={host} onScroll={() => {
      const element = host.current;
      if (!element) return;
      follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (!thread) entry.viewMode = follow.current && !view.newerTruncated ? 'live' : 'history';
      const top = element.getBoundingClientRect().top;
      const first = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.getBoundingClientRect().bottom >= top);
      if (first?.dataset.messageId) entry.scrollAnchors.set(scrollKey, { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top });
    }}>
      <div className="chat-history-action">
        {last?.hasMore && <button type="button" onClick={older} disabled={view.loading || !last.nextPageToken}>加载更早消息</button>}
        {view.loading && <span role="status">正在读取消息…</span>}
        {!view.loading && view.pages.length > 0 && !last?.hasMore && <span>已到可读取的最早消息</span>}
      </div>
      {!messages.length && !view.loading && <div className="chat-empty">暂无可显示消息</div>}
      <div ref={contentHost}>{messages.map((message) => <MessageItem key={message.messageId} controller={controller} entry={entry} message={message} bot={bot} onReference={showReference} />)}</div>
    </div>
  </>;
}

function Composer({ controller, entry, bot }: { controller: ChatController; entry: ChatEntry; bot?: Bot }) {
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string>();
  const uploadingController = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    if (!file) { setPreview(undefined); return; }
    const url = URL.createObjectURL(file); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; uploadingController.current?.abort(); }; }, []);
  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(chosen.type) || chosen.size > 10 * 1024 * 1024) {
      controller.setNotice('请选择 10 MiB 以内的 PNG、JPEG、WebP 或 GIF 图片'); return;
    }
    setFile(chosen);
  };
  const submit = async () => {
    if (uploading || entry.pending.size >= 3 || !entry.draft.trim() && !file) return;
    const controllerAbort = new AbortController(); uploadingController.current = controllerAbort;
    entry.controllers.add(controllerAbort);
    try {
      setUploading(true);
      const message: SendMessageInput['message'] = file
        ? { type: 'image', imageKey: (await controller.api.upload(entry.chat.botId, entry.chat.chatId, file, controllerAbort.signal)).imageKey }
        : { type: 'text', text: entry.draft.trim() };
      if (!controller.cache.current(entry) || controllerAbort.signal.aborted) return;
      const reply = entry.reply ?? (entry.openedThread ? { messageId: entry.openedThread.rootMessageId, mode: 'thread' as const } : undefined);
      const input: SendMessageInput = { clientRequestId: crypto.randomUUID(), message, reply };
      if (!file) entry.draft = '';
      setFile(undefined);
      await controller.send(entry, input);
    } catch (error) { if (!controllerAbort.signal.aborted) controller.report(error, entry); }
    finally { entry.controllers.delete(controllerAbort); if (mounted.current) setUploading(false); }
  };
  return <div className="chat-composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
    <div className="chat-composer-heading">以 <strong>{bot?.botName || bot?.name || '机器人'}</strong> 的身份发送
      {entry.openedThread && <span> · 当前话题</span>}
    </div>
    {entry.reply && <div className="chat-reply-target"><span>{entry.reply.mode === 'thread' ? '话题回复' : '引用回复'}：{entry.messages.get(entry.reply.messageId) ? messageText(entry.messages.get(entry.reply.messageId)!).slice(0, 100) : entry.reply.messageId}</span>
      <button type="button" onClick={() => { entry.reply = undefined; controller.cache.changed(); }}>取消</button></div>}
    {preview && <div className="chat-attachment"><img src={preview} alt="待发送图片" /><button type="button" onClick={() => setFile(undefined)}>移除图片</button><span>图片单独发送，输入文字作为草稿保留</span></div>}
    <textarea aria-label="聊天消息" placeholder="输入消息，Enter 发送，Shift+Enter 换行；支持粘贴图片" maxLength={4000} value={entry.draft}
      onChange={(event) => { entry.draft = event.target.value; controller.cache.changed(); }}
      onPaste={(event) => { const image = [...event.clipboardData.files].find((f) => f.type.startsWith('image/')); if (image) { event.preventDefault(); choose(image); } }}
      onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
    <div className="chat-composer-toolbar"><label className="chat-file-button">选择图片<input aria-label="选择聊天图片" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} /></label>
      <span className="chat-muted">{entry.draft.length}/4000</span><button type="button" className="chat-primary" disabled={uploading || entry.pending.size >= 3 || !entry.draft.trim() && !file} onClick={() => void submit()}>{uploading ? '发送中…' : '发送'}</button>
    </div>
    {[...entry.pending.entries()].map(([id, pending]) => <div className={`chat-pending chat-pending-${pending.status}`} key={id}>
      <span>{pending.input.message.type === 'text' ? pending.input.message.text.slice(0, 80) : '[图片]'} · {pending.status === 'sending' ? '发送中' : pending.status === 'unknown' ? '发送结果待确认，请先刷新最新消息' : '发送失败'}{pending.error ? `：${pending.error}` : ''}</span>
      {pending.status !== 'sending' && <><button type="button" onClick={() => controller.latest(entry)}>刷新</button><button type="button" onClick={() => void controller.send(entry, pending.input)}>使用相同发送编号重试</button>
        <button type="button" onClick={() => { entry.pending.delete(id); controller.cache.changed(); }}>关闭提示</button></>}
    </div>)}
  </div>;
}

export function FeishuChatPanel({ serverUrl, token, bots, onUnauthorized }: { serverUrl: string; token: string; bots: Bot[]; onUnauthorized: () => void }) {
  const controller = useChat(serverUrl, token, bots, onUnauthorized);
  const { entry, cache } = controller;
  const bot = bots.find((b) => b.id === entry?.chat.botId);
  return <section className="feishu-chat" aria-label="飞书群聊">
    <aside className="chat-sidebar">
      <label className="chat-bot-select">机器人<select aria-label="选择聊天机器人" value={controller.botId ?? ''} onChange={(event) => controller.setBotId(Number(event.target.value))}>
        {!bots.length && <option value="">暂无机器人</option>}{bots.map((b) => <option value={b.id} key={b.id}>{b.botName || b.name}</option>)}
      </select></label>
      <div className="chat-list-heading"><strong>已加入的群</strong><button type="button" disabled={controller.groupsLoading || !controller.ready} onClick={controller.refreshGroups}>刷新</button></div>
      {controller.groupError && <div className="chat-error">{controller.groupError}</div>}
      <div className="chat-group-list">
        {controller.groups.map((g) => <button type="button" key={g.chatId} className={`chat-group ${cache.activeKey === `${g.botId}:${g.chatId}` ? 'selected' : ''}`} disabled={!controller.ready} onClick={() => void controller.select(g)}>
          <span className="chat-group-avatar">{g.name.slice(0, 1)}</span><span>{g.name}</span>{controller.groupHints.has(`${g.botId}:${g.chatId}`) ? <small>新消息</small> : cache.entries.has(`${g.botId}:${g.chatId}`) && <small>已访问</small>}
        </button>)}
        {controller.groupsLoading && <div className="chat-muted">读取群列表…</div>}
        {!controller.groups.length && !controller.groupsLoading && <div className="chat-empty">{bots.length ? '暂无群聊，请刷新或将机器人加入群聊' : '请先绑定机器人'}</div>}
        {controller.groupToken && <button type="button" disabled={controller.groupsLoading} onClick={controller.moreGroups}>加载更多群</button>}
      </div>
      <details className="chat-recents"><summary>最近访问 · {cache.entries.size}/{MAX_CACHED_CHATS}</summary>
        {[...cache.entries.values()].sort((a, b) => b.lastVisited - a.lastVisited).map((e) => <button type="button" key={e.key} onClick={() => void controller.select(e.chat)}>{e.chat.name}</button>)}
        <p>仅保留本次运行中最近访问的会话</p>
      </details>
    </aside>
    <div className="chat-workspace">
      <div className="chat-workspace-header"><div><strong>{entry?.chat.name || '选择一个群聊'}</strong><div className="chat-muted">{controller.streamStatus}{entry && ` · 飞书：${controller.connections[entry.chat.botId]?.status || '状态待确认'}`}</div></div>
        {entry && <button type="button" onClick={() => controller.latest(entry)}>刷新最新</button>}
      </div>
      {controller.notice && <div className="chat-error" role="alert">{controller.notice}<button type="button" onClick={() => controller.setNotice('')}>关闭</button></div>}
      {entry ? <div className={`chat-conversation ${entry.openedThread ? 'with-thread' : ''}`} key={`${entry.key}:${entry.generation}`}>
        <div className="chat-main-timeline">
          {(entry.needsResync || entry.newMessages > 0 || entry.main.newerTruncated) && <div className="chat-new-hint"><span>{entry.needsResync ? '连接变化后需要校准消息' : '有新消息或更新'}</span><button type="button" onClick={() => controller.latest(entry)}>返回最新</button></div>}
          <MessageList key={entry.key} controller={controller} entry={entry} view={entry.main} bot={bot} />
          <Composer controller={controller} entry={entry} bot={bot} />
        </div>
        {entry.openedThread && <aside className="chat-thread"><div className="chat-thread-header"><strong>话题</strong><button type="button" onClick={() => { entry.openedThread = undefined; cache.changed(); }}>关闭话题</button></div>
          <MessageList key={entry.openedThread.threadId} controller={controller} entry={entry} view={cache.view(entry, entry.openedThread.threadId)} bot={bot} thread />
          <div className="chat-muted chat-thread-footer">下方输入框将发送到当前话题</div>
        </aside>}
      </div> : <div className="chat-empty chat-welcome"><strong>机器人群聊</strong><p>选择群聊后，按需读取飞书历史消息。支持引用回复和话题讨论。</p><span>历史只保存在当前窗口内存中，退出后重新读取。</span></div>}
    </div>
  </section>;
}
