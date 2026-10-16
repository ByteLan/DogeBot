import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import express from 'express';

// Never open the application's real database or contact a real Feishu tenant.
process.env.DOGEBOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'dogebot-chat-verify-'));
const { addUser, createToken, requireAuth } = await import('../src/auth.js');
const { db } = await import('../src/db.js');
const { createFeishuChatRouter } = await import('../src/feishu/chat/routes.js');
const { createFeishuBotForUser, listFeishuBots } = await import('../src/feishu/bot-management.js');
const { createChatMessage } = await import('../src/feishu/api.js');
const { dispatchFeishuMessage, dispatchFeishuRecall } = await import('../src/feishu/chat/ingress.js');
const { publishChatEvent } = await import('../src/feishu/chat/events.js');

addUser('chat-test-one', 'temporary-test-password');
addUser('chat-test-two', 'temporary-test-password');
const users = db.prepare('SELECT id, username FROM users ORDER BY id').all() as Array<{ id: number; username: string }>;
const tokens = users.map(createToken);
const bot1 = createFeishuBotForUser(users[0].id, { name: '聊天测试机器人', appId: 'cli_test_one', appSecret: 'fixture-only' }).bot!;
const bot2 = createFeishuBotForUser(users[1].id, { name: '其他用户机器人', appId: 'cli_test_two', appSecret: 'fixture-only' }).bot!;
db.prepare('UPDATE feishu_bots SET bot_open_id = ?, bot_name = ? WHERE id = ?').run('ou_bot', '聊天测试机器人', bot1.id);

type RawMessage = { message_id: string; chat_id: string; msg_type: string; create_time: string; update_time: string; body: { content: string };
  sender: { id: string; id_type: string; sender_type: string }; parent_id?: string; root_id?: string; thread_id?: string; deleted?: boolean };
const rawMessage = (id: string, text: string, extra: Partial<RawMessage> = {}): RawMessage => ({ message_id: id, chat_id: 'oc_1', msg_type: 'text',
  create_time: String(Date.now() - 60_000), update_time: String(Date.now() - 60_000), body: { content: JSON.stringify({ text }) },
  sender: { id: 'ou_member', id_type: 'open_id', sender_type: 'user' }, ...extra });
const messages = new Map<string, RawMessage>([
  ['om_root', rawMessage('om_root', '欢迎来到飞书群聊测试，支持历史与话题。', { thread_id: 'omt_one' })],
  ['om_quote', rawMessage('om_quote', '这是一条引用回复', { parent_id: 'om_root', root_id: 'om_root' })],
  ['om_reply', rawMessage('om_reply', '话题里面的历史回复', { parent_id: 'om_root', root_id: 'om_root', thread_id: 'omt_one' })],
  ['om_foreign', rawMessage('om_foreign', '其他群消息', { chat_id: 'oc_foreign' })]
]);
const upstreamCalls: Array<{ path: string; method: string; body?: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;
let sent = 0;
const fixturePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAoCAIAAADBrGu+AAAAWUlEQVR4nO3PUQkAIBTAwFfNQsY2hyH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBDrbS4hiUtIAAAAAASUVORK5CYII=', 'base64');
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  if (url.hostname !== 'open.feishu.cn') return originalFetch(input, init);
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
  upstreamCalls.push({ path: url.pathname + url.search, method, body });
  const ok = (data: unknown) => Response.json({ code: 0, data });
  if (url.pathname.includes('/tenant_access_token/')) return Response.json({ code: 0, tenant_access_token: 'fixture-tenant-token', expire: 7200 });
  if (url.pathname.endsWith('/chats')) return ok({ items: Array.from({ length: 12 }, (_, i) => ({ chat_id: `oc_${i + 1}`, name: `测试群 ${i + 1}`, chat_mode: 'group' })), has_more: false });
  if (url.pathname.endsWith('/members')) return ok({ items: [{ member_id: 'ou_member', name: '测试成员' }], has_more: false });
  if (/\/chats\/[^/]+$/.test(url.pathname)) return ok({ name: `测试群 ${url.pathname.split('_').at(-1)}`, chat_mode: 'group' });
  if (url.pathname.includes('/resources/')) return new Response(new Uint8Array(fixturePng), { headers: { 'content-type': 'image/png' } });
  if (url.pathname.endsWith('/images')) return ok({ image_key: 'img_fixture' });
  if (method === 'DELETE' && /\/messages\/[^/]+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1)!;
    const error = id === 'om_expired' ? 230009 : id === 'om_denied' ? 230026 : id === 'om_unsupported' ? 230054 : id === 'om_limited' ? 99991400 : 0;
    if (error) return Response.json({ code: error, msg: 'fixture recall rejected' }, { status: error === 99991400 ? 429 : 400 });
    if (id === 'om_unconfirmed') return Response.json({});
    const item = messages.get(id); assert.ok(item);
    item.deleted = true; item.body = { content: '{}' }; item.update_time = String(Date.now());
    if (id === 'om_recalled_elsewhere') return Response.json({ code: 230110, msg: 'Action unavailable as the message has been deleted.' }, { status: 400 });
    return ok({});
  }
  if (method === 'POST' && /\/messages(?:\/[^/]+\/reply)?$/.test(url.pathname)) {
    const parentId = url.pathname.endsWith('/reply') ? url.pathname.split('/').at(-2) : undefined;
    const parent = parentId ? messages.get(parentId) : undefined;
    const item = rawMessage(`om_sent_${++sent}`, '', { chat_id: String(body?.receive_id ?? parent?.chat_id ?? 'oc_1'),
      msg_type: String(body?.msg_type), body: { content: String(body?.content) }, create_time: String(Date.now()), update_time: String(Date.now()),
      parent_id: parentId, root_id: parent?.root_id || parentId, thread_id: body?.reply_in_thread || parent?.thread_id ? parent?.thread_id || 'omt_new' : undefined,
      sender: { id: 'cli_test_one', id_type: 'app_id', sender_type: 'app' } });
    messages.set(item.message_id, item); return ok(item);
  }
  if (url.pathname.endsWith('/messages')) {
    const container = url.searchParams.get('container_id');
    const thread = url.searchParams.get('container_id_type') === 'thread';
    return ok({ items: [...messages.values()].filter((m) => thread ? m.thread_id === container : m.chat_id === container && (!m.thread_id || !m.parent_id))
      .sort((a, b) => Number(b.create_time) - Number(a.create_time)), has_more: false });
  }
  const id = url.pathname.split('/').at(-1)!;
  if (messages.has(id)) return ok({ items: [messages.get(id)] });
  throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
};

const app = express();
app.use((_req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS'); next(); });
app.options('*', (_req, res) => { res.sendStatus(204); });
app.use(express.json());
app.get('/api/me', requireAuth, (req, res) => res.json({ user: (req as import('../src/auth.js').AuthenticatedRequest).user }));
app.get('/api/feishu/bots', requireAuth, listFeishuBots);
app.get('/api/feishu/connections', requireAuth, (_req, res) => res.json({ connections: [] }));
app.use('/api/feishu', createFeishuChatRouter());
const server = app.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;
const request = (path: string, options: RequestInit = {}, token = tokens[0]) => originalFetch(baseUrl + path, {
  ...options, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...options.headers }
});
const prefix = `/api/feishu/bots/${bot1.id}/chats`;
let passed = 0;
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }

async function eventStream(token: string) {
  const controller = new AbortController();
  const response = await request('/api/feishu/chat-events', { signal: controller.signal }, token);
  assert.equal(response.status, 200);
  const events: Array<{ type: string; message?: { messageId: string }; messageId?: string }> = [];
  let buffer = '';
  const consume = (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
      if (data) events.push(JSON.parse(data));
    }
  };
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  void (async () => {
    try { while (true) { const part = await reader.read(); if (part.done) break; consume(decoder.decode(part.value, { stream: true })); } }
    catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const until = async (predicate: (event: typeof events[number]) => boolean) => {
    for (let i = 0; i < 100; i++) { const found = events.find(predicate); if (found) return found; await wait(20); }
    throw new Error('Timed out waiting for fixture SSE event');
  };
  await until((e) => e.type === 'ready');
  return { controller, events, until };
}

const one = await eventStream(tokens[0]);
const two = await eventStream(tokens[1]);
try {
  await check('HTTP auth, ownership and no-store headers', async () => {
    assert.equal((await originalFetch(baseUrl + prefix)).status, 401);
    assert.equal((await request(`/api/feishu/bots/${bot2.id}/chats`)).status, 404);
    const response = await request(prefix); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).items.length, 12);
  });
  await check('history query, fixed pagination conditions and thread membership', async () => {
    const response = await request(prefix + '/oc_1/messages'); const page = await response.json();
    assert.equal(response.status, 200); assert.ok(page.snapshotEndTimeSeconds); assert.ok(page.items.some((m: { messageId: string }) => m.messageId === 'om_root'));
    assert.equal((await request(prefix + '/oc_1/messages?pageToken=next')).status, 400);
    assert.equal((await request(prefix + '/oc_1/threads/omt_one/messages?rootMessageId=om_root')).status, 200);
    assert.equal((await request(prefix + '/oc_1/threads/omt_other/messages?rootMessageId=om_root')).status, 403);
    assert.equal((await request(prefix + '/oc_1/messages/om_foreign')).status, 403);
    assert.ok(upstreamCalls.some((c) => c.path.includes('sort_type=ByCreateTimeDesc') && c.path.includes('page_size=50')));
  });
  await check('sending returns a message and publishes only to its owning user', async () => {
    const uuid = crypto.randomUUID();
    const response = await request(prefix + '/oc_1/messages', { method: 'POST', body: JSON.stringify({ clientRequestId: uuid, message: { type: 'text', text: '桌面发送验证' } }) });
    assert.equal(response.status, 200); const result = await response.json();
    await one.until((e) => e.message?.messageId === result.message.messageId);
    assert.equal(two.events.filter((e) => e.type !== 'ready').length, 0);
    assert.ok(upstreamCalls.some((c) => c.body?.uuid === uuid));
    const count = sent;
    assert.equal((await request(prefix + '/oc_1/messages', { method: 'POST', body: JSON.stringify({ clientRequestId: crypto.randomUUID(), message: { type: 'text', text: 'wrong group' }, reply: { messageId: 'om_foreign', mode: 'chat' } }) })).status, 403);
    assert.equal(sent, count);
  });
  await check('existing automatic sends and bot-message ingress reach desktop', async () => {
    const id = await createChatMessage(bot1, 'oc_1', 'text', { text: '现有自动发送验证' });
    await one.until((e) => e.message?.messageId === id);
    await dispatchFeishuMessage(bot1, { sender: { sender_type: 'bot', sender_id: { open_id: 'ou_other_bot' } }, message: { ...rawMessage('om_other_bot', '其他机器人消息'), message_type: 'text', content: '{"text":"其他机器人消息"}' } });
    await one.until((e) => e.message?.messageId === 'om_other_bot');
    dispatchFeishuRecall(bot1, { chat_id: 'oc_1', message_id: 'om_other_bot', recall_time: String(Date.now()) });
    await one.until((e) => e.type === 'message.recalled' && e.messageId === 'om_other_bot');
  });
  await check('reply mode, thread routing and image upload use the expected Feishu payloads', async () => {
    const response = await request(prefix + '/oc_1/messages', { method: 'POST', body: JSON.stringify({ clientRequestId: crypto.randomUUID(),
      message: { type: 'text', text: '话题回复验证' }, reply: { messageId: 'om_root', mode: 'thread' } }) });
    assert.equal(response.status, 200); assert.equal((await response.json()).message.threadId, 'omt_one');
    assert.ok(upstreamCalls.some((c) => c.path.endsWith('/om_root/reply') && c.body?.reply_in_thread === true));
    const upload = await request(prefix + '/oc_1/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(fixturePng) });
    assert.equal(upload.status, 200); assert.equal((await upload.json()).imageKey, 'img_fixture');
  });
  await check('image proxy validates parent chat and does not use a disk cache', async () => {
    assert.equal((await request(prefix + '/oc_1/messages/om_foreign/resources/img_x')).status, 403);
    const response = await request(prefix + '/oc_1/messages/om_root/resources/img_x');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.arrayBuffer()).byteLength, fixturePng.byteLength);
  });
  await check('recall rejects other users, chats, members and bots before issuing DELETE', async () => {
    messages.set('om_other_app', rawMessage('om_other_app', 'other app', { sender: { id: 'cli_other', id_type: 'app_id', sender_type: 'app' } }));
    const deletes = () => upstreamCalls.filter((c) => c.method === 'DELETE').length;
    const before = deletes();
    assert.equal((await request(prefix + '/oc_1/messages/om_root', { method: 'DELETE' }, tokens[1])).status, 404);
    assert.equal((await request(prefix + '/oc_1/messages/om_foreign', { method: 'DELETE' })).status, 403);
    assert.equal((await request(prefix + '/oc_1/messages/om_root', { method: 'DELETE' })).status, 403);
    assert.equal((await request(prefix + '/oc_1/messages/om_other_app', { method: 'DELETE' })).status, 403);
    assert.equal(deletes(), before); messages.delete('om_other_app');
  });
  await check('recall supports app_id/open_id and thread replies, no-store, SSE isolation and repeat requests', async () => {
    for (const [id, senderId, senderType] of [['om_own_app', 'cli_test_one', 'app_id'], ['om_own_open', 'ou_bot', 'open_id'], ['om_own_thread', 'cli_test_one', 'app_id'], ['om_recalled_elsewhere', 'cli_test_one', 'app_id']]) {
      messages.set(id, rawMessage(id, 'will recall', { sender: { id: senderId, id_type: senderType, sender_type: 'app' },
        ...(id === 'om_own_thread' ? { root_id: 'om_root', parent_id: 'om_root', thread_id: 'omt_one' } : {}) }));
      const response = await request(prefix + `/oc_1/messages/${id}`, { method: 'DELETE' });
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json(); assert.equal(result.messageId, id); assert.ok(result.recallTimeMs > 0);
      await one.until((e) => e.type === 'message.recalled' && e.messageId === id);
      assert.equal(messages.get(id)?.deleted, true);
      const count = upstreamCalls.filter((c) => c.method === 'DELETE').length;
      assert.equal((await request(prefix + `/oc_1/messages/${id}`, { method: 'DELETE' })).status, 200);
      assert.equal(upstreamCalls.filter((c) => c.method === 'DELETE').length, count);
      messages.delete(id);
    }
    assert.equal(two.events.filter((e) => e.type === 'message.recalled').length, 0);
  });
  await check('recall failures preserve messages and never publish a false recall', async () => {
    for (const [id, status] of [['om_expired', 400], ['om_denied', 403], ['om_unsupported', 400], ['om_limited', 429], ['om_unconfirmed', 502]] as const) {
      messages.set(id, rawMessage(id, 'must survive failure', { sender: { id: 'cli_test_one', id_type: 'app_id', sender_type: 'app' } }));
      const response = await request(prefix + `/oc_1/messages/${id}`, { method: 'DELETE' });
      assert.equal(response.status, status);
      assert.equal(messages.get(id)?.deleted, undefined);
      assert.equal(one.events.some((e) => e.type === 'message.recalled' && e.messageId === id), false);
      messages.delete(id);
    }
  });
  console.log(`${passed} Feishu chat API verification scenarios passed`);
} finally { one.controller.abort(); two.controller.abort(); }

if (process.argv.includes('--serve')) {
  const file = join(tmpdir(), 'dogebot-chat-fixture.json');
  writeFileSync(file, JSON.stringify({ baseUrl, token: tokens[0], dataDir: process.env.DOGEBOT_DATA_DIR }));
  writeFileSync(join(tmpdir(), 'dogebot-chat-fixture.png'), fixturePng);
  setInterval(() => publishChatEvent(bot1, { type: 'bot.connection', botId: bot1.id, status: 'connected' }), 15_000).unref();
  console.log(`Fixture running at ${baseUrl}; session in ${file}`);
} else {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = originalFetch;
}
