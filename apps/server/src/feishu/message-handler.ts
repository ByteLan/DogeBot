import type { FeishuBot } from '../types.js';
import { passiveInteractionConfig } from '../config.js';
import { parseFeishuMessage, messageChatId, senderIdentity, messageMentionsBot, isFromCurrentBot } from './message-parser.js';
import { readRecentChatMessages, rememberRecentChatMessage } from './chat-memory.js';
import { rememberFeishuEventKey } from './event-dedup.js';
import { replyText } from './api.js';
import { runPassiveInteractions } from './passive/index.js';

// Forward declaration - will be implemented when commands module is ready
// For now this re-exports from the old feishu.ts
export { handleFeishuMessage } from '../feishu.js';
