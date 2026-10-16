import React, { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Button, Checkbox, Dropdown, Empty, Image, Input, Menu, Modal, Select, Spin, Tooltip } from '@arco-design/web-react';
import { IconArrowDown, IconCheck, IconClockCircle, IconClose, IconCopy, IconDown, IconImage, IconMessage, IconMore, IconRefresh, IconReply, IconRight, IconRobot, IconSend, IconUndo, IconUserGroup } from '@arco-design/web-react/icon';
import type { RefTextAreaType } from '@arco-design/web-react/es/Input/textarea';
import type { Bot } from '../../types';
import type { ChatMessage, ChatSummary, OwnMessageAlignment, SendMessageInput } from './types';
import type { ChatEntry, Timeline } from './cache';
import { useChat, type ChatController } from './use-chat';
import './chat.css';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function messageText(message: ChatMessage) {
  if (message.deleted) return '消息已撤回';
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

const avatarColors = ['#4c83ed', '#36a590', '#8e6bd1', '#d58b42', '#5889ad'];
function avatarColor(name: string) {
  return avatarColors[Array.from(name).reduce((sum, character) => sum + character.charCodeAt(0), 0) % avatarColors.length];
}

function GroupAvatar({ chat }: { chat?: ChatSummary }) {
  return <Avatar className="chat-group-avatar" size={36} shape="square" style={{ backgroundColor: chat ? avatarColor(chat.name) : '#91a3be' }}>
    {chat?.avatar && /^https?:\/\//.test(chat.avatar) ? <img src={chat.avatar} alt="" /> : <IconUserGroup />}
  </Avatar>;
}

function senderName(message: ChatMessage, entry: ChatEntry, bot?: Bot) {
  if (message.sender.id && (message.sender.id === bot?.appId || message.sender.id === bot?.botOpenId)) return bot?.botName || bot?.name || '机器人';
  return message.sender.displayName || entry.memberNames.get(message.sender.id)
    || (message.sender.type === 'app' ? '机器人' : message.sender.id ? `成员 ${message.sender.id.slice(-6)}` : '群成员');
}

function timeLabel(time: number) {
  const date = new Date(time);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString() === today.toDateString() ? '今天'
    : date.toDateString() === yesterday.toDateString() ? '昨天'
    : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
  return `${day} ${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function threadReply(entry: ChatEntry, reply: SendMessageInput['reply']) {
  return reply?.mode === 'thread' && Boolean(entry.openedThread && (reply.messageId === entry.openedThread.rootMessageId
    || entry.messages.get(reply.messageId)?.threadId === entry.openedThread.threadId));
}

function MessageImage({ controller, entry, message, imageKey }: { controller: ChatController; entry: ChatEntry; message: ChatMessage; imageKey: string }) {
  const key = `${entry.key}:${message.messageId}:${imageKey}`;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const url = controller.cache.media.get(key)?.url;
  const load = async () => {
    if (!controller.receiveEnabled || !controller.viewing || request.current && !request.current.signal.aborted || controller.cache.mediaUrl(key)) return;
    const abort = controller.cache.read(entry);
    request.current = abort;
    setLoading(true); setError('');
    try {
      const blob = await controller.api.image(entry.chat.botId, entry.chat.chatId, message.messageId, imageKey, abort.signal);
      if (!abort.signal.aborted && !entry.messages.get(message.messageId)?.deleted) {
        controller.cache.putMedia(entry, key, blob); controller.cache.changed();
      }
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    finally {
      controller.cache.finishRead(abort);
      if (request.current === abort) { request.current = undefined; if (mounted.current) setLoading(false); }
    }
  };
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    mounted.current = true;
    if (!controller.receiveEnabled || !controller.viewing) {
      setLoading(false);
      return () => { mounted.current = false; request.current?.abort(); };
    }
    const observer = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) { observer.disconnect(); void loadRef.current(); }
    });
    if (host.current) observer.observe(host.current);
    return () => { mounted.current = false; observer.disconnect(); request.current?.abort(); };
  }, [key, controller.receiveEnabled, controller.viewing]);
  return <div ref={host} className="chat-message-image">
    {url ? <Image className="chat-image" src={url} alt="消息图片" loader={<Spin size={16} />} onError={() => setError('图片预览已释放，请重新加载')} />
      : <Button type="text" size="small" icon={<IconImage />} loading={loading} onClick={() => void load()}>{error || '加载图片'}</Button>}
  </div>;
}

function MessageItem({ controller, entry, message, bot, onReference, onRecall, ownMessageAlignment, grouped = false, inThread = false }: {
  controller: ChatController; entry: ChatEntry; message: ChatMessage; bot?: Bot; onReference: (id: string) => void;
  onRecall: (message: ChatMessage) => void; ownMessageAlignment: OwnMessageAlignment; grouped?: boolean; inThread?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  const self = Boolean(message.sender.type === 'app' && message.sender.id && (message.sender.id === bot?.appId || message.sender.id === bot?.botOpenId));
  const side = self ? ownMessageAlignment : 'left';
  const label = senderName(message, entry, bot);
  const quote = async (mode: 'chat' | 'thread') => {
    const current = await controller.ensureMessage(entry, message.messageId);
    if (!current) return;
    entry.reply = { messageId: current.messageId, mode };
    if (mode === 'thread') {
      if (current.threadId) await controller.openThread(entry, current);
      else entry.openedThread = undefined;
    }
    controller.cache.changed();
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(messageText(message));
      clearTimeout(copyTimer.current); setCopied(true);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    }
    catch { controller.setNotice('复制失败，请检查剪贴板权限'); }
  };
  if (message.msgType === 'system') return <div className="chat-system-message" data-message-id={message.messageId}>{message.deleted ? '消息已撤回' : messageText(message) === '[system]' ? '一条系统消息' : messageText(message)}</div>;
  return <article className={`chat-message ${self ? 'chat-message-self' : ''} ${grouped ? 'chat-message-grouped' : ''}`} data-side={side} data-message-id={message.messageId}>
    <div className="chat-message-avatar">{!grouped && <Tooltip content={label}><Avatar size={32} shape="square" style={{ backgroundColor: self ? '#4c83ed' : avatarColor(label) }}>{message.sender.type === 'app' ? <IconRobot /> : Array.from(label)[0]}</Avatar></Tooltip>}</div>
    <div className="chat-message-content">
      {!grouped && <header><strong title={message.sender.id}>{label}</strong></header>}
      <div className={`chat-message-body ${message.deleted ? 'chat-message-deleted' : ''}`} tabIndex={message.deleted ? -1 : 0} aria-label={`${label}的消息`}>
        {message.deleted ? <span className="chat-muted">消息已撤回</span> : <>
        {message.parentId && <Button className="chat-reference" type="text" size="mini" icon={<IconReply />} onClick={() => onReference(message.parentId!)}>
          {entry.messages.has(message.parentId) ? messageText(entry.messages.get(message.parentId)!).slice(0, 72) : '引用一条消息'}</Button>}
        {(message.msgType !== 'image' || message.contentState !== 'full') && <div className="chat-message-text">{messageText(message).split(/(https?:\/\/[^\s<>]+)/g).map((part, i) => /^https?:\/\//.test(part)
          ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part)}</div>}
        {imageKeys(message.content).map((key) => <MessageImage key={key} controller={controller} entry={entry} message={message} imageKey={key} />)}
        <div className="chat-message-sidecar" data-open={moreOpen}>
        <div className="chat-message-actions" role="toolbar" aria-label="消息操作">
          <Tooltip content="引用回复"><Button type="text" size="mini" icon={<IconReply />} aria-label="引用回复" onClick={() => quote(inThread || entry.chat.chatMode === 'topic' ? 'thread' : 'chat')} /></Tooltip>
          {message.msgType !== 'image' && <Tooltip content={copied ? '已复制' : '复制'}><Button type="text" size="mini" icon={copied ? <IconCheck /> : <IconCopy />} aria-label="复制消息" onClick={() => void copy()} /></Tooltip>}
          {self && <Tooltip content="撤回"><Button type="text" size="mini" icon={<IconUndo />} aria-label="撤回消息" loading={controller.isRecalling(entry, message.messageId)} onClick={() => onRecall(message)} /></Tooltip>}
          <Dropdown trigger="click" position={side === 'right' ? 'bl' : 'br'} onVisibleChange={setMoreOpen} droplist={<Menu onClickMenuItem={(key) => {
            if (key === 'reply') quote('thread');
            if (key === 'open') controller.openThread(entry, message);
          }}><Menu.Item key="reply"><IconMessage /> 话题回复</Menu.Item>{message.threadId && <Menu.Item key="open"><IconMessage /> 查看话题</Menu.Item>}</Menu>}>
            <Button type="text" size="mini" icon={<IconMore />} aria-label="更多消息操作" />
          </Dropdown>
        </div>
        {message.createTimeMs > 0 && <time title={new Date(message.createTimeMs).toLocaleString('zh-CN')}>
          {new Date(message.createTimeMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>}
        </div>
      </>}
      </div>
      {message.threadId && !message.deleted && !inThread && <Button type="text" size="mini" className="chat-thread-link" icon={<IconMessage />} onClick={() => controller.openThread(entry, message)}>查看话题 <IconRight /></Button>}
    </div>
  </article>;
}

function MessageList({ controller, entry, view, bot, onRecall, ownMessageAlignment, thread = false }: {
  controller: ChatController; entry: ChatEntry; view: Timeline; bot?: Bot;
  onRecall: (entry: ChatEntry, message: ChatMessage) => void; ownMessageAlignment: OwnMessageAlignment; thread?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const contentHost = useRef<HTMLDivElement>(null);
  const scrollKey = thread ? entry.openedThread?.threadId || 'main' : 'main';
  const mode = thread ? view.viewMode : entry.viewMode;
  const follow = useRef(mode === 'live');
  const anchor = useRef<{ id: string; offset: number } | undefined>(mode === 'history' ? entry.scrollAnchors.get(scrollKey) : undefined);
  const [reference, setReference] = useState<string>();
  const messages = controller.cache.messages(entry, view);
  const last = view.pages.at(-1);
  const signature = messages.map((m) => m.messageId).join(',');
  useEffect(() => {
    const element = host.current;
    if (!element || !controller.viewing) return;
    if (mode === 'live' && view.loading) { follow.current = true; anchor.current = undefined; }
    if (mode === 'history' && !anchor.current) anchor.current = entry.scrollAnchors.get(scrollKey);
    if (anchor.current) {
      const found = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.dataset.messageId === anchor.current?.id);
      if (found) element.scrollTop += found.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.current.offset;
      if (!view.loading) anchor.current = undefined;
    } else if (follow.current && (!view.newerTruncated || view.loading)) element.scrollTop = element.scrollHeight;
  }, [signature, view.loading, view.newerTruncated, view.generation, controller.viewing, mode]);
  const viewingRef = useRef(controller.viewing); viewingRef.current = controller.viewing;
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const element = host.current;
      if (!element || anchor.current || !viewingRef.current) return;
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
  const showReference = async (id: string) => {
    if (entry.unverifiedIds.has(id)) {
      const checked = await controller.detail(entry, id);
      if (!checked) return;
    }
    const existing = [...host.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? []].find((item) => item.dataset.messageId === id);
    if (existing) {
      existing.scrollIntoView({ block: 'center', behavior: 'smooth' });
      existing.querySelector('.chat-message-body')?.animate([{ boxShadow: '0 0 0 3px #a7c5ff' }, { boxShadow: '0 0 0 0 transparent' }], { duration: 1500 });
      return;
    }
    setReference(id); void controller.detail(entry, id);
  };
  const referenceMessage = reference ? entry.messages.get(reference) : undefined;
  return <div className="chat-timeline-stage">
    {view.error && <Alert className="chat-error" type="error" content={view.error} />}
    <Modal visible={Boolean(reference)} title="引用的消息" footer={null} onCancel={() => setReference(undefined)} className="chat-reference-modal">
      {referenceMessage ? <><div className="chat-reference-sender">{senderName(referenceMessage, entry, bot)}</div>
        <div className="chat-message-text">{referenceMessage.deleted ? '消息已撤回' : messageText(referenceMessage)}</div>
        {!referenceMessage.deleted && imageKeys(referenceMessage.content).map((key) => <MessageImage key={key} controller={controller} entry={entry} message={referenceMessage} imageKey={key} />)}</>
        : <Spin tip="正在读取引用消息…" />}
    </Modal>
    <div className="chat-message-list" ref={host} onScroll={() => {
      const element = host.current;
      if (!element || !controller.viewing) return;
      // Showing stale cache can emit layout scrolls before the resume query starts.
      // Preserve a live view until it is validated instead of treating that as reading history.
      if (view.loading || view.needsResync && (thread ? view.viewMode : entry.viewMode) === 'live') return;
      follow.current = !view.newerTruncated && element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      const nextMode = follow.current ? 'live' : 'history';
      const changed = (thread ? view.viewMode : entry.viewMode) !== nextMode;
      view.viewMode = nextMode;
      if (!thread) entry.viewMode = nextMode;
      const top = element.getBoundingClientRect().top;
      const first = [...element.querySelectorAll<HTMLElement>('[data-message-id]')].find((item) => item.getBoundingClientRect().bottom >= top);
      if (first?.dataset.messageId) entry.scrollAnchors.set(scrollKey, { id: first.dataset.messageId, offset: first.getBoundingClientRect().top - top });
      if (changed) controller.cache.changed();
    }}>
      <div className="chat-history-action">
        {last?.hasMore && <Button type="text" size="mini" onClick={older} disabled={view.loading || !last.nextPageToken}>加载更早消息</Button>}
        {view.loading && <Spin size={14} tip="正在读取消息" />}
        {!view.loading && view.pages.length > 0 && !last?.hasMore && <span>已到可读取的最早消息</span>}
      </div>
      {!messages.length && !view.loading && <Empty className="chat-empty" description="暂无消息，发送第一条消息吧" />}
      <div className="chat-message-items" ref={contentHost}>{messages.map((message, index) => {
        const previous = messages[index - 1];
        const separate = Boolean(message.createTimeMs && (!previous || message.createTimeMs - previous.createTimeMs >= 5 * 60_000
          || new Date(message.createTimeMs).toDateString() !== new Date(previous.createTimeMs).toDateString()));
        const grouped = !separate && Boolean(message.sender.id && previous?.sender.id === message.sender.id && previous.msgType !== 'system');
        return <React.Fragment key={message.messageId}>
          {separate && <div className="chat-time-divider">{timeLabel(message.createTimeMs)}</div>}
          <MessageItem controller={controller} entry={entry} message={message} bot={bot} onReference={showReference} onRecall={(message) => onRecall(entry, message)} ownMessageAlignment={ownMessageAlignment} grouped={grouped} inThread={thread} />
        </React.Fragment>;
      })}</div>
    </div>
    {(view.needsResync || view.newerTruncated || !thread && entry.newMessages > 0) && <Button className="chat-new-hint" size="small" icon={<IconArrowDown />} loading={view.loading} onClick={() => controller.latest(entry, view)}>
      {view.needsResync ? '消息可能有更新，查看最新' : thread ? '查看最新回复' : entry.newMessages > 0 ? `${entry.newMessages} 条新消息` : '返回最新消息'}</Button>}
  </div>;
}

function Composer({ controller, entry, bot, thread = false }: { controller: ChatController; entry: ChatEntry; bot?: Bot; thread?: boolean }) {
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string>();
  const [threadDraft, setThreadDraft] = useState('');
  const input = useRef<RefTextAreaType>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadingController = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const draft = thread ? threadDraft : entry.draft;
  const reply = entry.reply && (thread ? threadReply(entry, entry.reply) : !threadReply(entry, entry.reply)) ? entry.reply : undefined;
  useEffect(() => { if (reply) input.current?.focus(); }, [reply?.messageId, reply?.mode]);
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
    if (uploading || entry.pending.size >= 3 || !draft.trim() && !file) return;
    const target = reply ?? (thread && entry.openedThread ? { messageId: entry.openedThread.rootMessageId, mode: 'thread' as const } : undefined);
    const controllerAbort = new AbortController(); uploadingController.current = controllerAbort;
    entry.controllers.add(controllerAbort);
    try {
      setUploading(true);
      const message: SendMessageInput['message'] = file
        ? { type: 'image', imageKey: (await controller.api.upload(entry.chat.botId, entry.chat.chatId, file, controllerAbort.signal)).imageKey }
        : { type: 'text', text: draft.trim() };
      if (!controller.cache.current(entry) || controllerAbort.signal.aborted) return;
      const input: SendMessageInput = { clientRequestId: crypto.randomUUID(), message, reply: target };
      if (!file) { if (thread) setThreadDraft(''); else entry.draft = ''; }
      setFile(undefined);
      await controller.send(entry, input);
    } catch (error) { if (!controllerAbort.signal.aborted) controller.report(error, entry); }
    finally { entry.controllers.delete(controllerAbort); if (mounted.current) { setUploading(false); input.current?.focus(); } }
  };
  const pending = [...entry.pending.entries()].filter(([, item]) => thread ? threadReply(entry, item.input.reply) : !threadReply(entry, item.input.reply));
  return <div className={`chat-composer ${thread ? 'chat-thread-composer' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); choose(event.dataTransfer.files[0]); }}>
    {reply && <div className="chat-reply-target"><IconReply /><div><strong>{reply.mode === 'thread' ? '回复话题' : '引用回复'}</strong><span>{entry.messages.get(reply.messageId) ? messageText(entry.messages.get(reply.messageId)!).slice(0, 100) : '引用的消息'}</span></div>
      <Button type="text" size="mini" icon={<IconClose />} aria-label="取消回复" onClick={() => { entry.reply = undefined; controller.cache.changed(); }} /></div>}
    {preview && <div className="chat-attachment"><img src={preview} alt="待发送图片" /><span>{file?.name}<small>图片单独发送，文字保留为草稿</small></span><Button type="text" size="mini" icon={<IconClose />} aria-label="移除图片" onClick={() => setFile(undefined)} /></div>}
    <input ref={fileInput} className="chat-file-input" aria-label="上传聊天图片" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => { choose(event.target.files?.[0]); event.target.value = ''; }} />
    <Input.TextArea ref={input} aria-label={thread ? '话题消息' : '聊天消息'} placeholder={thread ? '回复话题…' : `发送到 ${entry.chat.name}`} maxLength={4000} value={draft} autoSize={{ minRows: 2, maxRows: 5 }}
      onChange={(value) => { if (thread) setThreadDraft(value); else { entry.draft = value; controller.cache.changed(); } }}
      onPaste={(event) => { const image = [...event.clipboardData.files].find((f) => f.type.startsWith('image/')); if (image) { event.preventDefault(); choose(image); } }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && reply) { entry.reply = undefined; controller.cache.changed(); }
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void submit(); }
      }} />
    <div className="chat-composer-toolbar"><Tooltip content="发送图片 · 支持粘贴和拖拽"><Button className="chat-file-button" type="text" size="small" icon={<IconImage />} aria-label="选择聊天图片" onClick={() => fileInput.current?.click()} /></Tooltip>
      <span className="chat-composer-shortcut">Enter 发送 · Shift+Enter 换行</span>
      <Tooltip content={`以 ${bot?.botName || bot?.name || '机器人'} 的身份发送`}><span className="chat-composer-identity"><IconRobot />{bot?.botName || bot?.name || '机器人'}</span></Tooltip>
      {draft.length > 0 && <span className="chat-word-count">{draft.length}/4000</span>}<Button type="primary" size="small" className="chat-primary" icon={<IconSend />} loading={uploading} disabled={entry.pending.size >= 3 || !draft.trim() && !file} onClick={() => void submit()}>发送</Button>
    </div>
    {pending.map(([id, pending]) => <div className={`chat-pending chat-pending-${pending.status}`} key={id}>
      <span>{pending.input.message.type === 'text' ? pending.input.message.text.slice(0, 80) : '[图片]'} · {pending.status === 'sending' ? '发送中' : pending.status === 'unknown' ? '发送结果待确认，请先刷新最新消息' : '发送失败'}{pending.error ? `：${pending.error}` : ''}</span>
      {pending.status !== 'sending' && <><Button type="text" size="mini" onClick={() => controller.latest(entry)}>刷新消息</Button><Button type="text" size="mini" onClick={() => void controller.send(entry, pending.input)}>重试发送</Button>
        <Button type="text" size="mini" icon={<IconClose />} aria-label="关闭发送提示" onClick={() => { entry.pending.delete(id); controller.cache.changed(); }} /></>}
    </div>)}
  </div>;
}

export function FeishuChatPanel({ serverUrl, token, bots, onUnauthorized, onManageBots, ownMessageAlignment = 'right', receiveEnabled = true, viewing = true, onRefreshBots }: {
  serverUrl: string; token: string; bots: Bot[]; onUnauthorized: () => void; onManageBots?: () => void; ownMessageAlignment?: OwnMessageAlignment;
  receiveEnabled?: boolean; viewing?: boolean; onRefreshBots?: (signal: AbortSignal) => Promise<Bot[]>;
}) {
  const controller = useChat(serverUrl, token, bots, onUnauthorized, { receiveEnabled, viewing, onRefreshBots });
  const { entry, cache } = controller;
  const [recallTarget, setRecallTarget] = useState<{ entry: ChatEntry; message: ChatMessage }>();
  const [skipRecallWarning, setSkipRecallWarning] = useState(false);
  const [recallError, setRecallError] = useState('');
  useEffect(() => { setRecallTarget(undefined); setSkipRecallWarning(false); setRecallError(''); }, [cache]);
  const recalling = Boolean(recallTarget && controller.isRecalling(recallTarget.entry, recallTarget.message.messageId));
  const requestRecall = (target: ChatEntry, message: ChatMessage) => {
    if (controller.isRecalling(target, message.messageId)) return;
    controller.setNotice('');
    if (!controller.needsRecallConfirmation()) { void controller.recall(target, message.messageId); return; }
    setSkipRecallWarning(false); setRecallError(''); setRecallTarget({ entry: target, message });
  };
  const bot = bots.find((b) => b.id === entry?.chat.botId);
  const activeGroup = entry ? controller.groups.find((g) => g.botId === entry.chat.botId && g.chatId === entry.chat.chatId) ?? entry.chat : undefined;
  const connection = controller.connections[entry?.chat.botId ?? controller.botId ?? -1];
  const views = entry ? [entry.main, ...(entry.openedThread ? [cache.view(entry, entry.openedThread.threadId)] : [])] : [];
  const syncFailed = controller.syncError || views.some((view) => view.error) || controller.groupError;
  const status = !receiveEnabled ? '已暂停收取' : controller.streamStatus !== '实时连接正常' ? controller.streamStatus
    : syncFailed ? '同步失败，可手动刷新' : controller.syncing || views.some((view) => view.loading) ? '正在同步'
    : views.some((view) => view.needsResync) ? '待同步' : connection?.status === 'connected' ? '实时同步' : '消息通道已连接';
  const connected = status === '实时同步';
  const recent = [...cache.entries.values()].sort((a, b) => b.lastVisited - a.lastVisited);
  return <section className="feishu-chat" aria-label="飞书群聊">
    <Modal visible={Boolean(recallTarget)} title="撤回这条消息？" className="chat-recall-modal" style={{ width: 420 }}
      okText="确认撤回" cancelText="取消" okButtonProps={{ status: 'danger' }} confirmLoading={recalling}
      maskClosable={!recalling} escToExit={!recalling} onCancel={() => { if (!recalling) setRecallTarget(undefined); }}
      onOk={async () => {
        if (!recallTarget) return;
        setRecallError('');
        const result = await controller.recall(recallTarget.entry, recallTarget.message.messageId);
        if (result.ok) {
          if (skipRecallWarning) controller.skipRecallConfirmation();
          setRecallTarget(undefined);
        } else setRecallError(result.error || '撤回失败，请稍后重试');
      }}>
      <p className="chat-recall-description">撤回后，群成员将无法查看这条消息。</p>
      <div className="chat-recall-preview">{recallTarget ? messageText(recallTarget.message) : ''}</div>
      {recallError && <Alert type="error" className="chat-recall-error" content={recallError} />}
      <Checkbox checked={skipRecallWarning} disabled={recalling} onChange={setSkipRecallWarning}>5 分钟内不再提醒</Checkbox>
    </Modal>
    <aside className="chat-sidebar">
      <div className="chat-sidebar-header"><h1>消息</h1><span>飞书群聊</span></div>
      <div className="chat-bot-select"><IconRobot /><Select aria-label="选择聊天机器人" size="small" value={controller.botId} placeholder="选择机器人" disabled={!bots.length}
        onChange={(value: number) => controller.setBotId(value)} options={bots.map((b) => ({ label: b.botName || b.name, value: b.id }))} /></div>
      <div className="chat-list-heading"><span>已加入的群 <small>{controller.groups.length}{controller.groupToken ? '+' : ''}</small></span>
        <Tooltip content="刷新群列表"><Button type="text" size="mini" icon={<IconRefresh />} aria-label="刷新群列表" loading={controller.groupsLoading} disabled={!controller.ready} onClick={controller.refreshGroups} /></Tooltip></div>
      {controller.groupError && <Alert className="chat-error" type="error" content={controller.groupError} />}
      <div className="chat-group-list">
        {controller.groups.map((g) => {
          const key = `${g.botId}:${g.chatId}`;
          const cached = cache.entries.get(key);
          const last = cached ? [...cached.messages.values()].sort((a, b) => b.createTimeMs - a.createTimeMs)[0] : undefined;
          return <button type="button" key={g.chatId} className={`chat-group ${cache.activeKey === key ? 'selected' : ''}`} aria-pressed={cache.activeKey === key} title={g.name} disabled={!controller.ready} onClick={() => void controller.select(g)}>
            <GroupAvatar chat={g} />
            <span className="chat-group-copy"><span className="chat-group-title">{g.name}</span><span className="chat-group-preview">{last ? `${last.deleted ? '' : `${senderName(last, cached!, bots.find((b) => b.id === g.botId))}：`}${last.deleted ? '消息已撤回' : messageText(last)}` : g.chatMode === 'topic' ? '话题群' : '点击查看群消息'}</span></span>
            <span className="chat-group-meta">{last && last.createTimeMs > 0 && <time>{new Date(last.createTimeMs).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}</time>}
              {controller.groupHints.has(key) && <span className="chat-unread-dot" aria-label="有新消息" />}</span>
          </button>;
        })}
        {controller.groupsLoading && !controller.groups.length && <div className="chat-list-loading"><Spin size={18} /></div>}
        {!controller.groups.length && !controller.groupsLoading && <Empty className="chat-empty" description={<><p>{bots.length ? controller.ready ? '机器人尚未加入群聊' : '正在连接服务端' : '请先绑定机器人'}</p>
          {!bots.length && onManageBots && <Button type="primary" size="small" onClick={onManageBots}>管理机器人</Button>}</>} />}
        {controller.groupToken && <Button className="chat-load-groups" type="text" size="small" loading={controller.groupsLoading} onClick={controller.moreGroups}>加载更多群</Button>}
      </div>
      <div className="chat-recents"><Dropdown trigger="click" position="top" droplist={<Menu className="chat-recents-menu" onClickMenuItem={(key) => { const target = cache.entries.get(key); if (target) void controller.select(target.chat); }}>
        {recent.length ? recent.map((e) => <Menu.Item key={e.key}>{e.chat.name}</Menu.Item>) : <Menu.Item key="empty" disabled>暂无最近会话</Menu.Item>}</Menu>}>
        <Button type="text" size="small" icon={<IconClockCircle />}>最近访问<IconDown /></Button>
      </Dropdown><span>{recent.length > 0 ? `${recent.length} 个会话` : ''}</span></div>
    </aside>
    <div className="chat-workspace">
      <div className="chat-workspace-header"><GroupAvatar chat={activeGroup} />
        <div className="chat-header-copy"><strong title={entry?.chat.name}>{entry?.chat.name || '飞书群聊'}</strong>
          <Tooltip content={`${status} · 机器人${connection?.status === 'connected' ? '已连接' : connection?.status === 'connecting' ? '连接中' : '连接状态待确认'}`}><span className="chat-connection-status" data-connected={connected} data-paused={!receiveEnabled} role="status"><i />{status}</span></Tooltip>
        </div>
        {entry && <Tooltip content="刷新最新消息"><Button type="text" size="small" icon={<IconRefresh />} aria-label="刷新最新消息" loading={entry.main.loading} onClick={() => controller.latest(entry)} /></Tooltip>}
      </div>
      {controller.notice && <Alert className="chat-notice" type="error" content={controller.notice} closable onClose={() => controller.setNotice('')} />}
      {entry ? <div className={`chat-conversation ${entry.openedThread ? 'with-thread' : ''}`} key={`${entry.key}:${entry.generation}`}>
        <div className="chat-main-timeline">
          <MessageList key={entry.key} controller={controller} entry={entry} view={entry.main} bot={bot} onRecall={requestRecall} ownMessageAlignment={ownMessageAlignment} />
          <Composer controller={controller} entry={entry} bot={bot} />
        </div>
        {entry.openedThread && <aside className="chat-thread" aria-label="话题讨论"><div className="chat-thread-header"><span><IconMessage /><strong>话题讨论</strong></span><Tooltip content="关闭话题"><Button type="text" size="mini" icon={<IconClose />} aria-label="关闭话题" onClick={() => { entry.openedThread = undefined; if (entry.reply?.mode === 'thread') entry.reply = undefined; cache.changed(); }} /></Tooltip></div>
          <MessageList key={entry.openedThread.threadId} controller={controller} entry={entry} view={cache.view(entry, entry.openedThread.threadId)} bot={bot} onRecall={requestRecall} ownMessageAlignment={ownMessageAlignment} thread />
          <Composer key={entry.openedThread.threadId} controller={controller} entry={entry} bot={bot} thread />
        </aside>}
      </div> : <div className="chat-welcome"><div className="chat-welcome-icon"><IconMessage /></div><h2>开始一段对话</h2><p>从左侧选择群聊，查看消息或以机器人身份回复。</p><span>历史消息仅在本次使用期间保留</span></div>}
    </div>
  </section>;
}
