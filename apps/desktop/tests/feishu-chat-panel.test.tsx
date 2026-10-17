// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FeishuChatPanel } from '../src/renderer/feishu/chat/FeishuChatPanel';
import { ChatApi } from '../src/renderer/feishu/chat/api';
import type { ChatMessage, SendMessageInput } from '../src/renderer/feishu/chat/types';
import type { Bot } from '../src/renderer/types';

const bot: Bot = { id: 1, name: '测试机器人', appId: 'cli_test', botName: '测试机器人', botOpenId: 'ou_bot',
  domain: 'feishu', hasAdmin: true, webhookPath: '/fixture' };
const message = (id: string, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ botId: 1, chatId: 'oc_1',
  messageId: id, sender: { id: 'ou_member', idType: 'open_id', type: 'user' }, msgType: 'text', createTimeMs: 1000,
  content: { text }, deleted: false, mentions: [], contentState: 'full', ...extra });
const messages = [message('om_main_a', '主线消息 A'), message('om_main_b', '主线消息 B'),
  message('om_root_one', '话题一根消息', { threadId: 'omt_one' }), message('om_root_two', '话题二根消息', { threadId: 'omt_two' }),
  message('om_reply_one', '话题一回复', { threadId: 'omt_one', rootId: 'om_root_one', parentId: 'om_root_one' }),
  message('om_reply_two', '话题二回复', { threadId: 'omt_two', rootId: 'om_root_two', parentId: 'om_root_two' })];
let sent = 0;

function result(input: SendMessageInput) {
  return { clientRequestId: input.clientRequestId, message: message(`om_sent_${++sent}`, input.message.type === 'text' ? input.message.text : '图片', {
    sender: { id: bot.appId, idType: 'app_id', type: 'app' },
    ...(input.reply?.mode === 'thread' ? { threadId: 'omt_one', parentId: input.reply.messageId, rootId: 'om_root_one' } : {})
  }) };
}

beforeEach(() => {
  sent = 0;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = vi.fn(() => `blob:fixture-${Math.random()}`);
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(ChatApi.prototype, 'groups').mockResolvedValue({ items: [1, 2].map((i) => ({ botId: 1, chatId: `oc_${i}`, name: `测试群 ${i}`, chatMode: 'group' })), hasMore: false });
  vi.spyOn(ChatApi.prototype, 'chat').mockImplementation(async (_botId, chatId) => ({ chat: { botId: 1, chatId, name: `测试群 ${chatId.slice(-1)}`, chatMode: 'group' } }));
  vi.spyOn(ChatApi.prototype, 'members').mockResolvedValue({ items: [], hasMore: false });
  vi.spyOn(ChatApi.prototype, 'detail').mockImplementation(async (_botId, _chatId, id) => ({ message: messages.find((m) => m.messageId === id)! }));
  vi.spyOn(ChatApi.prototype, 'history').mockImplementation(async (_botId, chatId, _signal, options = {}) => ({
    items: chatId !== 'oc_1' ? [] : messages.filter((m) => options.threadId ? m.threadId === options.threadId : !m.parentId),
    hasMore: false, snapshotEndTimeSeconds: '2'
  }));
  vi.spyOn(ChatApi.prototype, 'upload').mockResolvedValue({ imageKey: 'img_uploaded' });
  vi.spyOn(ChatApi.prototype, 'send').mockImplementation(async (_botId, _chatId, input) => result(input));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openChat() {
  const rendered = render(<FeishuChatPanel serverUrl="http://fixture.invalid" token="fixture" bots={[bot]} onUnauthorized={vi.fn()}
    receiveEnabled={false} manualOnly />);
  fireEvent.click(screen.getByRole('button', { name: '刷新群列表' }));
  await screen.findByRole('button', { name: /测试群 1/ });
  fireEvent.click(screen.getByRole('button', { name: /测试群 1/ }));
  fireEvent.click(screen.getByRole('button', { name: '刷新最新消息' }));
  await waitFor(() => expect(rendered.container.querySelector('[data-message-id="om_main_a"]')).not.toBeNull());
  return rendered;
}

function article(container: HTMLElement, id: string) {
  const item = container.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
  expect(item).not.toBeNull(); return item!;
}

async function openThread(container: HTMLElement, number: 'one' | 'two', refresh = true) {
  fireEvent.click(within(article(container, `om_root_${number}`)).getByRole('button', { name: /查看话题/ }));
  await screen.findByRole('complementary', { name: '话题讨论' });
  if (refresh) {
    fireEvent.click(screen.getByRole('button', { name: '刷新话题消息' }));
    await waitFor(() => expect(container.querySelector(`.chat-thread [data-message-id="om_reply_${number}"]`)).not.toBeNull());
  }
}

test('main and thread quotes remain independent when cancelling and sending from either editor', async () => {
  const { container } = await openChat(); await openThread(container, 'one');
  fireEvent.click(within(article(container, 'om_main_a')).getByRole('button', { name: '引用回复' }));
  await waitFor(() => expect(container.querySelector('.chat-main-timeline .chat-reply-target')?.textContent).toContain('主线消息 A'));
  fireEvent.click(within(article(container, 'om_reply_one')).getByRole('button', { name: '引用回复' }));
  await waitFor(() => expect(container.querySelector('.chat-thread .chat-reply-target')?.textContent).toContain('话题一回复'));
  expect(container.querySelector('.chat-main-timeline .chat-reply-target')?.textContent).toContain('主线消息 A');
  const thread = screen.getByRole('complementary', { name: '话题讨论' });
  fireEvent.click(within(thread).getByRole('button', { name: '取消回复' }));
  expect(container.querySelector('.chat-main-timeline .chat-reply-target')?.textContent).toContain('主线消息 A');
  fireEvent.change(screen.getByRole('textbox', { name: '话题消息' }), { target: { value: '话题发送' } });
  fireEvent.click(within(thread).getByRole('button', { name: '发送' }));
  await waitFor(() => expect(ChatApi.prototype.send).toHaveBeenCalledTimes(1));
  expect(vi.mocked(ChatApi.prototype.send).mock.calls[0][2].reply).toEqual({ messageId: 'om_root_one', mode: 'thread' });
  await waitFor(() => expect(within(thread).getByRole('button', { name: '发送' }).getAttribute('disabled')).not.toBeNull());
  expect(container.querySelector('.chat-main-timeline .chat-reply-target')?.textContent).toContain('主线消息 A');
  fireEvent.change(screen.getByRole('textbox', { name: '聊天消息' }), { target: { value: '主线发送' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天消息' }), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(ChatApi.prototype.send).toHaveBeenCalledTimes(2));
  expect(vi.mocked(ChatApi.prototype.send).mock.calls[1][2].reply).toEqual({ messageId: 'om_main_a', mode: 'chat' });
});

test('an earlier send completion cannot erase a newer quote selected in the same editor', async () => {
  const { container } = await openChat();
  let finish!: (value: ReturnType<typeof result>) => void;
  vi.mocked(ChatApi.prototype.send).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(within(article(container, 'om_main_a')).getByRole('button', { name: '引用回复' }));
  await waitFor(() => expect(container.querySelector('.chat-reply-target')?.textContent).toContain('主线消息 A'));
  fireEvent.change(screen.getByRole('textbox', { name: '聊天消息' }), { target: { value: '延迟发送' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '聊天消息' }), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(ChatApi.prototype.send).toHaveBeenCalledOnce());
  fireEvent.click(within(article(container, 'om_main_b')).getByRole('button', { name: '引用回复' }));
  await waitFor(() => expect(container.querySelector('.chat-reply-target')?.textContent).toContain('主线消息 B'));
  await act(async () => finish(result(vi.mocked(ChatApi.prototype.send).mock.calls[0][2])));
  expect(container.querySelector('.chat-reply-target')?.textContent).toContain('主线消息 B');
});

test('main/thread drafts and images survive closing threads, switching threads and switching groups', async () => {
  const { container } = await openChat(); await openThread(container, 'one');
  fireEvent.change(screen.getByRole('textbox', { name: '聊天消息' }), { target: { value: '主线草稿' } });
  fireEvent.change(screen.getByRole('textbox', { name: '话题消息' }), { target: { value: '话题一草稿' } });
  const main = container.querySelector<HTMLElement>('.chat-main-timeline')!;
  const thread = screen.getByRole('complementary', { name: '话题讨论' });
  fireEvent.change(within(main).getByLabelText('上传聊天图片'), { target: { files: [new File(['main'], 'main.png', { type: 'image/png' })] } });
  fireEvent.change(within(thread).getByLabelText('上传聊天图片'), { target: { files: [new File(['one'], 'one.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('button', { name: '关闭话题' }));
  await openThread(container, 'two');
  expect((screen.getByRole('textbox', { name: '话题消息' }) as HTMLTextAreaElement).value).toBe('');
  fireEvent.change(screen.getByRole('textbox', { name: '话题消息' }), { target: { value: '话题二草稿' } });
  await openThread(container, 'one', false);
  expect((screen.getByRole('textbox', { name: '话题消息' }) as HTMLTextAreaElement).value).toBe('话题一草稿');
  expect(screen.getByRole('complementary', { name: '话题讨论' }).textContent).toContain('one.png');
  fireEvent.click(screen.getByRole('button', { name: /测试群 2/ }));
  fireEvent.click(screen.getByRole('button', { name: /测试群 1/ }));
  expect((screen.getByRole('textbox', { name: '聊天消息' }) as HTMLTextAreaElement).value).toBe('主线草稿');
  expect((screen.getByRole('textbox', { name: '话题消息' }) as HTMLTextAreaElement).value).toBe('话题一草稿');
  expect(container.querySelector('.chat-main-timeline')?.textContent).toContain('main.png');
  expect(container.querySelector('.chat-thread')?.textContent).toContain('one.png');
  await openThread(container, 'two', false);
  expect((screen.getByRole('textbox', { name: '话题消息' }) as HTMLTextAreaElement).value).toBe('话题二草稿');
  expect(URL.revokeObjectURL).toHaveBeenCalled();
});

test('an image submission continues after switching groups instead of being cancelled by unmount', async () => {
  await openChat();
  let finish!: (value: { imageKey: string }) => void;
  vi.mocked(ChatApi.prototype.upload).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.change(screen.getByLabelText('上传聊天图片'), { target: { files: [new File(['image'], 'image.png', { type: 'image/png' })] } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(ChatApi.prototype.upload).toHaveBeenCalledOnce());
  const signal = vi.mocked(ChatApi.prototype.upload).mock.calls[0][3];
  fireEvent.click(screen.getByRole('button', { name: /测试群 2/ }));
  expect(signal.aborted).toBe(false);
  await act(async () => finish({ imageKey: 'img_after_switch' }));
  expect(ChatApi.prototype.send).toHaveBeenCalledWith(1, 'oc_1', expect.objectContaining({ message: { type: 'image', imageKey: 'img_after_switch' } }), expect.anything());
  expect(signal.aborted).toBe(false);
});

test('a delayed thread send preserves the newly opened thread and its draft', async () => {
  const { container } = await openChat(); await openThread(container, 'one');
  let finish!: (value: ReturnType<typeof result>) => void;
  vi.mocked(ChatApi.prototype.send).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  fireEvent.change(screen.getByRole('textbox', { name: '话题消息' }), { target: { value: '旧话题发送' } });
  fireEvent.click(within(screen.getByRole('complementary', { name: '话题讨论' })).getByRole('button', { name: '发送' }));
  await waitFor(() => expect(ChatApi.prototype.send).toHaveBeenCalledOnce());
  await openThread(container, 'two');
  fireEvent.change(screen.getByRole('textbox', { name: '话题消息' }), { target: { value: '新话题草稿' } });
  await act(async () => finish(result(vi.mocked(ChatApi.prototype.send).mock.calls[0][2])));
  expect((screen.getByRole('textbox', { name: '话题消息' }) as HTMLTextAreaElement).value).toBe('新话题草稿');
  expect(container.querySelector('.chat-thread [data-message-id="om_reply_two"]')).not.toBeNull();
});
