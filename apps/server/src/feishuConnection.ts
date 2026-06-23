import type { FeishuBot } from './feishu.js';
import { getEnabledBots, handleFeishuMessage } from './feishu.js';

type LarkModule = typeof import('@larksuiteoapi/node-sdk');
type ManagedConnection = {
  botId: number;
  userId: number;
  status: 'starting' | 'connected' | 'reconnecting' | 'failed' | 'stopped';
  startedAt: string;
  error?: string;
  wsClient: InstanceType<LarkModule['WSClient']>;
};

function sdkDomain(lark: LarkModule, domain: string) {
  if (domain === 'lark') return lark.Domain.Lark;
  if (domain === 'feishu') return lark.Domain.Feishu;
  return domain;
}

class FeishuConnectionManager {
  private readonly connections = new Map<number, ManagedConnection>();

  async startAll() {
    await Promise.allSettled(getEnabledBots().map((bot) => this.startBot(bot)));
  }

  async startBot(bot: FeishuBot) {
    if (!bot.enabled || bot.user_id == null) return;
    this.stopBot(bot.id);

    const lark = await import('@larksuiteoapi/node-sdk');
    const connection: ManagedConnection = {
      botId: bot.id,
      userId: bot.user_id,
      status: 'starting',
      startedAt: new Date().toISOString(),
      wsClient: new lark.WSClient({
        appId: bot.app_id,
        appSecret: bot.app_secret,
        domain: sdkDomain(lark, bot.domain),
        autoReconnect: true,
        loggerLevel: lark.LoggerLevel.warn,
        source: 'dogebot',
        onReady: () => {
          connection.status = 'connected';
          connection.error = undefined;
          console.log(`[feishu] bot ${bot.id} connected`);
        },
        onReconnecting: () => {
          connection.status = 'reconnecting';
        },
        onReconnected: () => {
          connection.status = 'connected';
          connection.error = undefined;
        },
        onError: (error) => {
          connection.status = 'failed';
          connection.error = error.message;
          console.error(`[feishu] bot ${bot.id} connection failed`, error);
        }
      })
    };

    this.connections.set(bot.id, connection);
    try {
      await connection.wsClient.start({
        eventDispatcher: new lark.EventDispatcher({
          encryptKey: bot.encrypt_key || undefined,
          verificationToken: bot.verification_token || undefined
        }).register({
          'im.message.receive_v1': async (data: any) => {
            void handleFeishuMessage(bot, data?.event || data).catch((error) => {
              console.error(`[feishu] bot ${bot.id} message handling failed`, error);
            });
          },
          'im.message.reaction.created_v1': async (data: any) => {
            const event = data?.event || data;
            console.log('[feishu] reaction event received', {
              botId: bot.id,
              messageId: event?.message_id || event?.message?.message_id || '',
              reactionType: event?.reaction_type?.emoji_type || event?.reaction?.reaction_type?.emoji_type || '',
              operatorId: event?.operator_id?.open_id || event?.operator?.operator_id?.open_id || ''
            });
          }
        })
      });
    } catch (error) {
      connection.status = 'failed';
      connection.error = error instanceof Error ? error.message : String(error);
      console.error(`[feishu] bot ${bot.id} start failed`, error);
    }
  }

  stopBot(botId: number) {
    const connection = this.connections.get(botId);
    if (!connection) return;
    connection.status = 'stopped';
    connection.wsClient.close({ force: true });
    this.connections.delete(botId);
  }

  stopAll() {
    for (const botId of this.connections.keys()) this.stopBot(botId);
  }

  snapshot() {
    return [...this.connections.values()].map((connection) => ({
      botId: connection.botId,
      userId: connection.userId,
      status: connection.wsClient.getConnectionStatus?.().state || connection.status,
      startedAt: connection.startedAt,
      error: connection.error
    }));
  }
}

export const feishuConnectionManager = new FeishuConnectionManager();
