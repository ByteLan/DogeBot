import { afterAll, beforeEach, expect, test, vi } from 'vitest';
import { databaseFixture } from './database-fixture.js';
import type { FeishuBot } from '../src/types.js';

const releaseDatabase = databaseFixture('dogebot-users-test-');
const { db } = await import('../src/db.js');
const api = await import('../src/feishu/api.js');
const users = await import('../src/feishu/commands/users.js');
const { handleFeishuCommand } = await import('../src/feishu/commands/index.js');
const { handleFeishuCardAction } = await import('../src/feishu/card-action.js');
const { handleFeishuMessage } = await import('../src/feishu/message-handler.js');
const passive = await import('../src/feishu/passive/index.js');
const { parseUsersCommand, parseUsersCopySource } = await import('../src/feishu/commands/parsers.js');
const { parseFeishuMessage, usersCopyCommandInput } = await import('../src/feishu/message-parser.js');
const { buildUsersCopyCard, USERS_COPY_CARD_KIND } = await import('../src/feishu/cards/users-copy-card.js');
afterAll(releaseDatabase);

db.prepare(`INSERT INTO feishu_bots (id, user_id, name, app_id, app_secret) VALUES (1, 1, 'test', 'cli_test', 'fixture-only'), (2, 1, 'other', 'cli_other', 'fixture-only')`).run();
const bot = db.prepare('SELECT * FROM feishu_bots WHERE id = 1').get() as FeishuBot;
bot.bot_open_id = 'ou_bot';
const owner = { id: 'ou_owner', name: '触发人' };
const source = 'ou_source';

beforeEach(() => {
  vi.restoreAllMocks();
  db.prepare('DELETE FROM at_users_record').run();
  db.prepare('DELETE FROM feishu_users_copy_requests').run();
  // All Feishu sends are mocked; assertions use a real, isolated SQLite database.
  vi.spyOn(api, 'replyCard').mockResolvedValue('om_copy');
  vi.spyOn(api, 'replyText').mockResolvedValue('om_text');
  vi.spyOn(api, 'updateInteractiveMessage').mockResolvedValue(undefined);
  vi.spyOn(api, 'deleteMessage').mockResolvedValue(undefined);
  vi.spyOn(users, 'replyUsersCard').mockResolvedValue(undefined);
  vi.spyOn(passive, 'runPassiveInteractions').mockResolvedValue(undefined);
});

function message(text = '/users --copy-from @_source', extra: Record<string, unknown> = {}) {
  return {
    message_id: 'om_command', chat_id: 'oc_test', chat_type: 'p2p', message_type: 'text',
    content: JSON.stringify({ text }),
    mentions: [
      { key: '@_bot', id: { open_id: bot.bot_open_id }, name: 'DogeBot' },
      { key: '@_source', id: { open_id: source }, name: '名字 带空格' },
      { key: '@_other', id: { open_id: 'ou_other' }, name: '名字 带空格' },
      { key: '@_all', id: { open_id: 'all' }, name: '所有人' },
      { key: '@_owner', id: { open_id: owner.id }, name: owner.name }
    ].filter((mention) => text.split(/\s+/).includes(mention.key)), ...extra
  };
}

async function command(input = message(), sender = owner.id) {
  return handleFeishuCommand(bot, {
    sender: { sender_id: { open_id: sender }, sender_name: owner.name, sender_type: 'user' }, message: input
  }, input.message_id, parseFeishuMessage(input).text, { allowSetDefault: true });
}

function requestId() {
  const request = db.prepare('SELECT id FROM feishu_users_copy_requests').get() as { id: string } | undefined;
  expect(request).toBeDefined();
  return request!.id;
}

function payload(action = 'confirm', operatorId = owner.id, overrides: Record<string, unknown> = {}) {
  return { header: { event_id: 'same-event-id' }, event: {
    context: { open_message_id: 'om_copy', open_chat_id: 'oc_test' },
    operator: { operator_id: { open_id: operatorId } },
    action: { value: { kind: USERS_COPY_CARD_KIND, action, requestId: requestId() } }, ...overrides
  } };
}

const ids = (botId = bot.id, atBy = owner.id) => users.listMentions(botId, atBy).map((record) => record.at_who);
const status = () => (db.prepare('SELECT status FROM feishu_users_copy_requests').get() as { status: string }).status;

test('ordinary /users still adds, deduplicates, tops, limits and soft-deletes', async () => {
  await command(message('/users @_source'));
  await command(message('/users @_source @_other'));
  expect(ids()).toEqual([source, 'ou_other']);
  await command(message('/users top @_other'));
  expect(ids()).toEqual(['ou_other', source]);
  await command(message('/users new 1'));
  expect(users.replyUsersCard).toHaveBeenLastCalledWith(bot, 'om_command', [{ at_who: 'ou_other', at_who_name: '名字 带空格' }]);
  await command(message('/users delete @_source'));
  expect(ids()).toEqual(['ou_other']);
  await command(message('/users delete'));
  expect(ids()).toEqual([]);
});

test('copy source must be a single real mention after the flag, with bot mentions excluded', async () => {
  expect(parseUsersCommand('/users --copy-from @成员').copyFrom).toBe(true);
  for (const text of ['/users --copy-from', '/users --copy-from @手写姓名', '/users --copy-from @_source @_other',
    '/users --copy-from @_all', '/users --copy-from @_bot', '/users --copy-from @_source new 1',
    '/users delete --copy-from @_source', '/users --copy-from @_source top', '/users @_source --copy-from',
    '/users --copy-from @_source --copy-from @_other', '/users --copy-from @_owner']) {
    await command(message(text));
    expect(db.prepare('SELECT id FROM feishu_users_copy_requests').all()).toHaveLength(0);
    expect(ids()).toEqual([]);
  }
  await command(message('@_bot /users --copy-from @_source @_bot'));
  expect(status()).toBe('pending');
  expect(api.replyCard).toHaveBeenCalledTimes(1);
  expect(users.replyUsersCard).not.toHaveBeenCalled();
});

test('rich text copy resolves identity from at blocks, including names with spaces', async () => {
  const input = message('', { message_type: 'post', content: JSON.stringify({ content: [[
    { tag: 'at', user_id: 'ou_bot', user_name: 'Bot' },
    { tag: 'text', text: '/users --copy-from ' },
    { tag: 'at', user_id: source, user_name: '名字 带空格' }
  ]] }) });
  const parsed = usersCopyCommandInput(input);
  expect(parseUsersCopySource(parsed.text, parsed.mentions, bot.bot_open_id)).toBe(source);
  await command(input);
  expect(status()).toBe('pending');
});

test('message entry accepts private chats or groups mentioning the bot and deduplicates events', async () => {
  const sender = { sender_id: { open_id: owner.id }, sender_type: 'user', sender_name: owner.name };
  await handleFeishuMessage(bot, { sender, message: message('/users --copy-from @_source', { message_id: 'om_group_no_at', chat_type: 'group' }) });
  expect(api.replyCard).not.toHaveBeenCalled();
  expect(passive.runPassiveInteractions).toHaveBeenCalledTimes(1);
  const group = { sender, message: message('@_bot /users --copy-from @_source', { message_id: 'om_group_at', chat_type: 'group' }) };
  await handleFeishuMessage(bot, group);
  await handleFeishuMessage(bot, group);
  expect(api.replyCard).toHaveBeenCalledTimes(1);
  await handleFeishuMessage(bot, { sender: { ...sender, sender_type: 'app' }, message: message('/users --copy-from @_source', { message_id: 'om_bot_sent' }) });
  expect(api.replyCard).toHaveBeenCalledTimes(1);
  await handleFeishuMessage(bot, { sender, message: message('/users --copy-from @_source', { message_id: 'om_private' }) });
  expect(api.replyCard).toHaveBeenCalledTimes(2);
});

test('preview and result reveal counts only, and confirming merges current active records in the same bot', async () => {
  users.upsertMentions(1, source, '来源', [
    { id: 'ou_keep', name: '成员甲' }, { id: 'ou_restore', name: '成员乙' },
    { id: 'ou_add', name: '成员丙' }, { id: 'ou_deleted', name: '来源已删除' }
  ]);
  users.softDeleteMentions(1, source, ['ou_deleted']);
  users.upsertMentions(2, source, '其他bot', [{ id: 'ou_foreign', name: '其他bot人员' }]);
  users.upsertMentions(1, owner.id, owner.name, [{ id: 'ou_keep', name: '旧名字' }, { id: 'ou_restore', name: '已删除' }, { id: 'ou_own', name: '保留原人员' }]);
  users.softDeleteMentions(1, owner.id, ['ou_restore']);
  users.topMentions(1, owner.id, ['ou_own']);
  await command();
  expect(ids()).toEqual(['ou_own', 'ou_keep']);
  const card = vi.mocked(api.replyCard).mock.calls[0][2] as ReturnType<typeof buildUsersCopyCard>;
  expect(card.body.elements[0]).toMatchObject({ content: expect.stringContaining('**3**') });
  expect(JSON.stringify(card)).not.toMatch(/ou_|成员甲|成员乙|成员丙|person_list|<at/);
  const buttons = card.body.elements.find((element) => 'columns' in element);
  expect(buttons?.columns?.map((column) => column.elements[0].text.content)).toEqual(['撤回', '确认']);
  users.softDeleteMentions(1, source, ['ou_add']);
  users.upsertMentions(1, source, '来源', [{ id: 'ou_late', name: '确认前新加入' }]);
  await handleFeishuCardAction(bot, payload());
  expect(new Set(ids())).toEqual(new Set(['ou_own', 'ou_keep', 'ou_restore', 'ou_late']));
  expect(ids()[0]).toBe('ou_own');
  expect(ids(1, source)).toEqual(['ou_keep', 'ou_restore', 'ou_late']);
  expect(status()).toBe('confirmed');
  expect(JSON.stringify(vi.mocked(api.updateInteractiveMessage).mock.calls[0][2])).toContain('新增或恢复 **2** 位');
  expect(JSON.stringify(vi.mocked(api.updateInteractiveMessage).mock.calls[0][2])).not.toMatch(/ou_|person_list|<at/);
  expect(users.replyUsersCard).not.toHaveBeenCalled();
});

test('both buttons reject other people, missing identities, other bots/chats/messages and forged request ids', async () => {
  users.upsertMentions(1, source, '来源', [{ id: 'ou_add', name: '人员' }]);
  await command();
  for (const action of ['confirm', 'withdraw']) {
    for (const operator of ['ou_intruder', '']) await handleFeishuCardAction(bot, payload(action, operator));
    await handleFeishuCardAction({ ...bot, id: 2 }, payload(action));
    await handleFeishuCardAction(bot, payload(action, owner.id, { context: { open_message_id: 'om_copy', open_chat_id: 'oc_other' } }));
    await handleFeishuCardAction(bot, payload(action, owner.id, { context: { open_message_id: 'om_other', open_chat_id: 'oc_test' } }));
    await handleFeishuCardAction(bot, payload(action, owner.id, { operator: {} }));
    await handleFeishuCardAction(bot, payload(action, owner.id, { action: { value: { kind: USERS_COPY_CARD_KIND, action, requestId: 'forged', atById: owner.id } } }));
  }
  expect(ids()).toEqual([]);
  expect(status()).toBe('pending');
  expect(api.updateInteractiveMessage).not.toHaveBeenCalled();
  expect(api.deleteMessage).not.toHaveBeenCalled();
  await handleFeishuCardAction(bot, payload());
  expect(ids()).toEqual(['ou_add']);
});

test('withdraw cancels copying even if recalling fails; a later withdraw can retry', async () => {
  await command();
  vi.mocked(api.deleteMessage).mockRejectedValueOnce(new Error('fixture network failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await handleFeishuCardAction(bot, payload('withdraw'));
  expect(status()).toBe('withdrawn');
  await handleFeishuCardAction(bot, payload('confirm'));
  await handleFeishuCardAction(bot, payload('withdraw'));
  expect(api.deleteMessage).toHaveBeenCalledTimes(2);
  expect(api.updateInteractiveMessage).not.toHaveBeenCalled();
  expect(ids()).toEqual([]);
});

test('confirmation is durable and idempotent, including concurrent callbacks and failed result updates', async () => {
  users.upsertMentions(1, source, '来源', [{ id: 'ou_add', name: '人员' }]);
  await command();
  vi.mocked(api.updateInteractiveMessage).mockRejectedValueOnce(new Error('fixture update failure'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await Promise.all([handleFeishuCardAction(bot, payload()), handleFeishuCardAction(bot, payload())]);
  expect(ids()).toEqual(['ou_add']);
  users.softDeleteMentions(1, owner.id, ['ou_add']);
  users.upsertMentions(1, source, '来源', [{ id: 'ou_late', name: '新人员' }]);
  // A callback with a new event ID must still not repeat a completed request.
  await handleFeishuCardAction(bot, { ...payload(), header: { event_id: 'new-event-id' } });
  expect(ids()).toEqual([]);
  expect(status()).toBe('confirmed');
  expect(JSON.stringify(vi.mocked(api.updateInteractiveMessage).mock.calls.at(-1)?.[2])).toContain('**1**');
});

test('a database failure rolls back all copied members and the request can be retried', async () => {
  users.upsertMentions(1, source, '来源', [{ id: 'ou_first', name: '第一位' }, { id: 'ou_fail', name: '失败位' }]);
  await command();
  db.exec(`CREATE TRIGGER fail_users_copy BEFORE INSERT ON at_users_record WHEN NEW.at_by = 'ou_owner' AND NEW.at_who = 'ou_fail' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`);
  try {
    await expect(handleFeishuCardAction(bot, payload())).rejects.toThrow('fixture write failure');
    expect(ids()).toEqual([]);
    expect(status()).toBe('pending');
  } finally {
    db.exec('DROP TRIGGER fail_users_copy');
  }
  await handleFeishuCardAction(bot, payload());
  expect(ids()).toEqual(['ou_first', 'ou_fail']);
  expect(status()).toBe('confirmed');
});

test('empty sources confirm safely; failed card sends leave no pending request', async () => {
  await command();
  await handleFeishuCardAction(bot, payload());
  expect(ids()).toEqual([]);
  expect(JSON.stringify(vi.mocked(api.updateInteractiveMessage).mock.calls[0][2])).toContain('**0**');
  db.prepare('DELETE FROM feishu_users_copy_requests').run();
  vi.mocked(api.replyCard).mockRejectedValueOnce(new Error('fixture send failure'));
  await expect(command()).rejects.toThrow('fixture send failure');
  expect(db.prepare('SELECT * FROM feishu_users_copy_requests').all()).toHaveLength(0);
  vi.mocked(api.replyCard).mockResolvedValueOnce('');
  await expect(command()).rejects.toThrow('missing message_id');
  expect(db.prepare('SELECT * FROM feishu_users_copy_requests').all()).toHaveLength(0);
});

test('copy includes all records beyond the normal card display group size', async () => {
  users.upsertMentions(1, source, '来源', Array.from({ length: 1005 }, (_, index) => ({ id: `ou_member_${index}`, name: `成员${index}` })));
  await command();
  await handleFeishuCardAction(bot, payload());
  expect(ids()).toHaveLength(1005);
  expect(JSON.stringify(vi.mocked(api.updateInteractiveMessage).mock.calls[0][2])).toContain('**1005**');
});

test('pending and completed requests survive module reloads, and deleting a bot removes its requests', async () => {
  users.upsertMentions(1, source, '来源', [{ id: 'ou_add', name: '人员' }]);
  await command();
  const context = { requestId: requestId(), messageId: 'om_copy', chatId: 'oc_test', operatorId: owner.id, action: 'confirm' as const };
  vi.resetModules();
  const freshApi = await import('../src/feishu/api.js');
  vi.spyOn(freshApi, 'updateInteractiveMessage').mockResolvedValue(undefined);
  const freshCopy = await import('../src/feishu/commands/users-copy.js');
  await freshCopy.handleUsersCopyCardAction(bot, context);
  expect(ids()).toEqual(['ou_add']);
  users.softDeleteMentions(1, owner.id, ['ou_add']);
  vi.resetModules();
  const reloadedApi = await import('../src/feishu/api.js');
  vi.spyOn(reloadedApi, 'updateInteractiveMessage').mockResolvedValue(undefined);
  const reloadedCopy = await import('../src/feishu/commands/users-copy.js');
  await reloadedCopy.handleUsersCopyCardAction(bot, context);
  expect(ids()).toEqual([]);
  expect(status()).toBe('confirmed');
  db.prepare('DELETE FROM feishu_bots WHERE id = 1').run();
  expect(db.prepare('SELECT * FROM feishu_users_copy_requests').all()).toHaveLength(0);
});
