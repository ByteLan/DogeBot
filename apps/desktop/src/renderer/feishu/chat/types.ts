export type ChatSummary = {
  botId: number;
  chatId: string;
  name: string;
  avatar?: string;
  chatMode: 'group' | 'topic' | 'unknown';
};

export type ChatMessage = {
  botId: number;
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  sender: {
    id: string;
    idType: 'open_id' | 'app_id' | 'unknown';
    type: 'user' | 'app' | 'anonymous' | 'unknown';
    displayName?: string;
  };
  msgType: string;
  createTimeMs: number;
  updateTimeMs?: number;
  deleted: boolean;
  contentState: 'full' | 'summary' | 'unavailable';
  content: unknown;
  mentions: Array<{ id: string; name?: string; key?: string }>;
};

export type HistoryPage = {
  items: ChatMessage[];
  hasMore: boolean;
  nextPageToken?: string;
  snapshotEndTimeSeconds?: string;
};

export type BotChatConnection = { botId: number; status: string; error?: string };

export type ChatEvent =
  | { type: 'ready'; streamId: string; connections: BotChatConnection[] }
  | { type: 'message.upsert'; botId: number; message: ChatMessage; clientRequestId?: string }
  | { type: 'message.recalled'; botId: number; chatId?: string; messageId: string; recallTimeMs: number }
  | { type: 'message.refresh'; botId: number; chatId?: string; messageId?: string }
  | { type: 'bot.connection'; botId: number; status: string; error?: string }
  | { type: 'bot.removed'; botId: number };

export type SendMessageInput = {
  clientRequestId: string;
  message: { type: 'text'; text: string } | { type: 'image'; imageKey: string };
  reply?: { messageId: string; mode: 'chat' | 'thread' };
};

export type OwnMessageAlignment = 'left' | 'right';

export type ChatReceiveMode = 'always' | 'when-viewing' | 'manual';
