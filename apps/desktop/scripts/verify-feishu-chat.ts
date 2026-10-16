import assert from 'node:assert/strict';
import { ChatCache, MAX_CACHED_CHATS, MAX_MESSAGES_PER_CHAT } from '../src/renderer/feishu/chat/cache.ts';
import { SseParser } from '../src/renderer/feishu/chat/sse.ts';
import { normalizeMessage } from '../../server/src/feishu/chat/normalize.ts';
import type { ChatMessage, ChatSummary } from '../src/renderer/feishu/chat/types.ts';

const chat = (i: number, botId = 1): ChatSummary => ({ botId, chatId: `oc_${i}`, name: `群 ${i}`, chatMode: 'group' });
const message = (i: number, overrides: Partial<ChatMessage> = {}): ChatMessage => ({ botId: 1, chatId: 'oc_1', messageId: `om_${i}`,
  sender: { id: 'ou_test', idType: 'open_id', type: 'user' }, msgType: 'text', createTimeMs: i * 1000,
  content: { text: `消息 ${i}` }, deleted: false, mentions: [], contentState: 'full', ...overrides });
let passed = 0;
const check = (name: string, run: () => void) => { run(); passed++; console.log(`PASS ${name}`); };

check('LRU uses visits across bots; events cannot recreate or promote entries', () => {
  const c = new ChatCache();
  for (let i = 1; i <= 10; i++) c.visit(chat(i, i % 2 + 1));
  c.incoming(message(1, { botId: 2 }));
  c.visit(chat(11));
  assert.equal(c.entries.size, MAX_CACHED_CHATS);
  assert.equal(c.entries.has('2:oc_1'), false);
  c.incoming(message(2, { botId: 2 }));
  assert.equal(c.entries.has('2:oc_1'), false);
  c.clear();
});

check('late responses cannot revive an evicted entry or overwrite a newer query', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); const old = c.begin(e, e.main, true);
  c.remove(e.key); const replacement = c.visit(chat(1));
  assert.equal(e.messages.size, 0);
  c.page(old, { items: [message(1)], hasMore: false }, 'replace');
  assert.equal(replacement.messages.size, 0);
  const first = c.begin(replacement, replacement.main, true); c.begin(replacement, replacement.main, true);
  assert.equal(c.valid(first), undefined); c.clear();
});

check('eviction clears history even when an async sender retains the entry object', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); c.incoming(message(1)); e.draft = 'unsent';
  const controller = new AbortController(); e.controllers.add(controller);
  for (let i = 2; i <= 11; i++) c.visit(chat(i));
  assert.equal(e.messages.size, 0); assert.equal(e.draft, ''); assert.equal(controller.signal.aborted, true); c.clear();
});

check('tombstone overflow cancels stale reads before forgetting a recalled ID', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); const ticket = c.begin(e, e.main, true);
  for (let i = 0; i <= 300; i++) c.recall(1, 'oc_1', `om_${i}`, 9000);
  assert.equal(c.valid(ticket), undefined);
  c.page(ticket, { items: [message(0)], hasMore: false }, 'replace');
  assert.equal(e.messages.size, 0); assert.ok(e.tombstones.size <= 300); c.clear();
});

check('history response preserves incoming messages and recalled tombstones', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); const t = c.begin(e, e.main, true);
  c.incoming(message(100)); c.recall(1, 'oc_1', 'om_1', 9000);
  c.page(t, { items: [message(1), message(2)], hasMore: false }, 'replace');
  assert.equal(e.messages.get('om_1')?.deleted, true);
  assert.deepEqual(e.messages.get('om_1')?.content, {});
  assert.ok(c.messages(e).some((m) => m.messageId === 'om_100')); c.clear();
});

check('older HTTP versions cannot clobber a newer event', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); c.incoming(message(1));
  const t = c.begin(e, e.main, true);
  c.incoming(message(1, { updateTimeMs: 9000, content: { text: 'edited' } }));
  c.page(t, { items: [message(1)], hasMore: false }, 'replace');
  assert.deepEqual(e.messages.get('om_1')?.content, { text: 'edited' }); c.clear();
});

check('partial refreshes preserve known content and thread identity', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); c.incoming(message(1, { threadId: 'omt_known' }));
  c.incoming(message(1, { contentState: 'unavailable', content: {} }));
  assert.equal(e.messages.get('om_1')?.threadId, 'omt_known');
  assert.deepEqual(e.messages.get('om_1')?.content, { text: '消息 1' }); c.clear();
});

check('message budget includes multiple thread windows and live heads', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  for (let thread = 0; thread < 12; thread++) {
    const view = c.view(e, `omt_${thread}`); const t = c.begin(e, view, true);
    c.page(t, { items: Array.from({ length: 50 }, (_, i) => message(thread * 50 + i, { threadId: `omt_${thread}`, parentId: 'om_root' })), hasMore: false }, 'replace');
  }
  for (let i = 1000; i < 1400; i++) c.incoming(message(i));
  assert.ok(e.messages.size <= MAX_MESSAGES_PER_CHAT, String(e.messages.size));
  assert.ok(e.revisions.size <= MAX_MESSAGES_PER_CHAT); c.clear();
});

check('evicting old pages preserves the continuation before the released range', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  for (let p = 0; p < 6; p++) {
    const t = c.begin(e, e.main, p === 0);
    c.page(t, { items: Array.from({ length: 50 }, (_, i) => message(1000 - p * 50 - i)), hasMore: true, nextPageToken: `after_${p}`, snapshotEndTimeSeconds: '2000' }, p ? 'older' : 'replace');
  }
  for (let i = 1100; i < 1150; i++) c.incoming(message(i));
  assert.equal(e.main.pages.at(-1)?.nextPageToken, 'after_4');
  assert.ok(e.messages.size <= 300); c.clear();
});

check('missing overlap never stitches distant history to a latest page', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  c.page(c.begin(e, e.main, true), { items: [message(1)], hasMore: true, nextPageToken: 'old' }, 'replace');
  e.viewMode = 'history';
  c.page(c.begin(e, e.main, true), { items: [message(1000)], hasMore: true, nextPageToken: 'new' }, 'validate');
  assert.equal(e.main.newerTruncated, true);
  assert.deepEqual(c.messages(e).map((m) => m.messageId), ['om_1']);
  c.dirty(); const ticket = c.begin(e, e.main, true); c.incoming(message(1001));
  c.page(ticket, { items: [message(1000)], hasMore: false }, 'replace');
  assert.deepEqual(c.messages(e).map((m) => m.messageId), ['om_1000', 'om_1001']); c.clear();
});

check('the first thread reply updates its root without caching every unopened thread', () => {
  const c = new ChatCache(); const e = c.visit(chat(1)); c.incoming(message(1));
  c.incoming(message(2, { threadId: 'omt_new', rootId: 'om_1', parentId: 'om_1' }));
  assert.equal(e.messages.get('om_1')?.threadId, 'omt_new');
  assert.equal(e.threads.size, 0); assert.equal(e.messages.has('om_2'), false);
  assert.equal(e.newMessages, 1); c.clear();
});

check('shared media is bounded and URLs are released on recall/eviction', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  c.putMedia(e, `${e.key}:om_1:img_a`, new Blob([new Uint8Array(10 * 1024 * 1024)]));
  c.putMedia(e, `${e.key}:om_2:img_b`, new Blob([new Uint8Array(10 * 1024 * 1024)]));
  assert.equal(c.media.size, 1);
  c.recall(1, 'oc_1', 'om_2', 9000); assert.equal(c.media.size, 0); c.clear();
});

check('recall clears quote targets and shared thread/reference content without losing drafts', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  const root = message(1, { threadId: 'omt_one' });
  c.incoming(root); c.detail(e, root);
  const view = c.view(e, 'omt_one');
  c.page(c.begin(e, view, true), { items: [root], hasMore: false }, 'replace');
  e.reply = { messageId: root.messageId, mode: 'chat' }; e.draft = 'keep this unsent draft';
  c.putMedia(e, `${e.key}:${root.messageId}:img_a`, new Blob(['image']));
  c.recall(1, 'oc_1', root.messageId, 9000);
  assert.equal(e.reply, undefined); assert.equal(e.draft, 'keep this unsent draft');
  assert.equal(c.messages(e)[0]?.deleted, true); assert.equal(c.messages(e, view)[0]?.deleted, true);
  assert.deepEqual(e.messages.get(root.messageId)?.content, {}); assert.equal(c.media.size, 0);
  c.recall(1, 'oc_1', root.messageId, 9001); c.incoming(root);
  assert.equal(e.messages.get(root.messageId)?.deleted, true); c.clear();
});

check('byte budget evicts inactive sessions and releases distant active pages first', () => {
  const c = new ChatCache(); const body = 'x'.repeat(200_000);
  for (let group = 1; group <= 3; group++) {
    const e = c.visit(chat(group));
    c.page(c.begin(e, e.main, true), { items: Array.from({ length: 50 }, (_, i) => message(i, { chatId: e.chat.chatId, content: { text: body } })), hasMore: true, nextPageToken: 'next' }, 'replace');
  }
  assert.equal(c.entries.size, 1);
  const e = c.entries.get(c.activeKey)!;
  c.page(c.begin(e, e.main, false), { items: Array.from({ length: 50 }, (_, i) => message(i + 50, { chatId: e.chat.chatId, content: { text: body } })), hasMore: true, nextPageToken: 'after' }, 'older');
  assert.equal(e.main.pages.length, 1);
  assert.ok([...e.messages.values()].every((m) => m.contentState === 'full'));
  c.clear();
});

check('pausing cancels only reads, invalidates late pages and preserves the conversation and writes', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  c.page(c.begin(e, e.main, true), { items: [message(1)], hasMore: false }, 'replace');
  e.draft = 'keep draft'; e.reply = { messageId: 'om_1', mode: 'chat' };
  e.scrollAnchors.set('main', { id: 'om_1', offset: 12 });
  const thread = c.view(e, 'omt_one'); e.openedThread = { threadId: 'omt_one', rootMessageId: 'om_1' };
  const old = c.begin(e, e.main, true), firstThread = c.begin(e, thread, true);
  const details = c.read(e), groups = c.read(), write = new AbortController(); e.controllers.add(write);
  c.dirty();
  assert.equal(old.controller.signal.aborted, true); assert.equal(firstThread.controller.signal.aborted, true);
  assert.equal(details.signal.aborted, true); assert.equal(groups.signal.aborted, true);
  assert.equal(write.signal.aborted, false); assert.equal(e.controllers.has(write), true);
  assert.equal(e.main.loading, false); assert.equal(thread.loading, false);
  assert.equal(e.main.needsResync, true); assert.equal(thread.needsResync, true);
  assert.equal(e.draft, 'keep draft'); assert.equal(e.reply?.messageId, 'om_1');
  assert.equal(e.openedThread.threadId, 'omt_one'); assert.equal(e.scrollAnchors.get('main')?.offset, 12);
  c.page(old, { items: [message(2)], hasMore: false }, 'replace'); assert.equal(e.messages.has('om_2'), false);
  assert.equal(e.unverifiedIds.has('om_1'), true);
  c.page(c.begin(e, e.main, true), { items: [message(1)], hasMore: false }, 'replace');
  assert.equal(e.unverifiedIds.has('om_1'), false); assert.equal(e.main.needsResync, false);
  assert.equal(thread.needsResync, true); assert.equal(thread.pages.length, 0);
  c.clear(); assert.equal(write.signal.aborted, true);
});

check('confirmed sends survive a paused timeline and a single-detail check cannot validate the whole view', () => {
  const c = new ChatCache(); const e = c.visit(chat(1));
  c.page(c.begin(e, e.main, true), { items: [message(1), message(2)], hasMore: false }, 'replace');
  e.pending.set('request-one', { status: 'sending', input: { clientRequestId: 'request-one', message: { type: 'text', text: 'hello' } } });
  c.dirty(); c.incoming(message(3), 'request-one');
  assert.equal(e.pending.size, 0); assert.equal(e.messages.has('om_3'), true);
  c.detail(e, message(1, { deleted: true, content: {} }));
  assert.equal(e.unverifiedIds.has('om_1'), false); assert.equal(e.unverifiedIds.has('om_2'), true);
  assert.equal(e.main.needsResync, true); assert.equal(e.messages.get('om_1')?.deleted, true);
  c.clear();
});

check('session cleanup cancels metadata queries without a selected conversation', () => {
  const c = new ChatCache(); const groups = c.read(); c.clear();
  assert.equal(groups.signal.aborted, true);
});

check('SSE handles split UTF-8, CRLF, multiline data and heartbeat comments', () => {
  const events: Array<[string, string]> = [];
  const parser = new SseParser((name, data) => events.push([name, data]));
  const bytes = new TextEncoder().encode(': 心跳\r\n\r\nevent: ready\r\ndata: 第一行\r\ndata: 第二行\r\n\r\n');
  const decoder = new TextDecoder();
  for (const byte of bytes) parser.push(decoder.decode(new Uint8Array([byte]), { stream: true }));
  assert.deepEqual(events, [['ready', '第一行\n第二行']]);
});

check('normalization maps event sender, mentions and recalled content', () => {
  const result = normalizeMessage(1, { message_id: 'om_1', chat_id: 'oc_1', message_type: 'text', create_time: '1000', content: '{"text":"hi"}', mentions: [{ id: { open_id: 'ou_1' }, key: '@_user_1', name: '张三' }] }, { sender_type: 'bot', sender_id: { open_id: 'ou_bot' } });
  assert.equal(result?.sender.type, 'app'); assert.equal(result?.sender.id, 'ou_bot');
  assert.equal(result?.mentions[0].id, 'ou_1');
  assert.deepEqual(normalizeMessage(1, { message_id: 'om_2', chat_id: 'oc_1', deleted: true, body: { content: '{"text":"secret"}' } })?.content, {});
});

console.log(`${passed} Feishu chat verification scenarios passed`);
