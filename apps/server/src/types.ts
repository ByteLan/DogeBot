import type { StickerFlavor } from './styleStickerCore.js';

export type FeishuBot = {
  id: number;
  user_id: number | null;
  name: string;
  app_id: string;
  app_secret: string;
  domain: string;
  verification_token: string;
  encrypt_key: string;
  bot_name: string | null;
  bot_open_id: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

export type FeishuMention = {
  key?: string;
  name?: string;
  id?: string | {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  id_type?: string;
  tenant_key?: string;
};

export type AtRecord = {
  at_who: string;
  at_who_name: string;
};

export type UsersCommand = {
  isUsers: boolean;
  shouldDelete: boolean;
  shouldTop: boolean;
  newCount?: number;
};

export type DouyinCommand = {
  isDouyin: boolean;
  clickText: string;
  count: number;
  hasCountFlag: boolean;
  shouldDelete: boolean;
  shouldSubscribe: boolean;
  shouldUnsubscribe: boolean;
  deleteAwemeId: string;
  hasInvalidCount: boolean;
  hasInvalidDelete: boolean;
  hasConflictingAction: boolean;
};

export type SetDefaultCommand = {
  isSetDefault: boolean;
  defaultCommand: string;
};

export type DefaultCommandRecord = {
  defaultCommand: string;
  adminUserId: string;
};

export type SetDefaultCommandResult =
  | { ok: true; assignedAdmin: boolean }
  | { ok: false; adminUserId: string };

export type AddCronCommand = {
  isAddCron: boolean;
  cronExpr: string;
  commandText: string;
  shouldList: boolean;
  deleteIndex?: number;
  hasInvalidDelete: boolean;
  hasConflictingAction: boolean;
};

export type RevertCommand = {
  isRevert: boolean;
  command: string;
  hasUnknownArgs: boolean;
};

export type HelpCommandRow = {
  command: string;
  params: string;
  description: string;
};

export type PassiveFeature = 'reaction' | 'repeat' | 'llm_reply' | 'media_repeat' | 'image_reverse' | 'sticker_reverse';
export type ProbabilisticFeature = PassiveFeature | StyleStickerFeature;

export type PassiveToggleCommand =
  | { isPassiveToggle: false }
  | {
    isPassiveToggle: true;
    command: string;
    feature: PassiveFeature;
    featureName: string;
    shouldEnable: boolean;
    shouldDisable: boolean;
    rate?: number;
    hasConflictingAction: boolean;
    hasInvalidRate: boolean;
    hasUnknownArgs: boolean;
  };

export type StyleStickerFeature = 'byte_style' | 'scale_new_heights';

export type StyleStickerCommand =
  | { isStyleSticker: false }
  | {
    isStyleSticker: true;
    command: string;
    feature: StyleStickerFeature;
    featureName: string;
    flavor: StickerFlavor;
    shouldEnable: boolean;
    shouldDisable: boolean;
    rate?: number;
    maxChars?: number;
    hasConflictingAction: boolean;
    hasInvalidRate: boolean;
    hasInvalidMax: boolean;
    text: string;
  };

export type ChatCronTask = {
  id: number;
  bot_id: number;
  chat_id: string;
  cron_expr: string;
  command_text: string;
  next_run_at: string;
};

export type DouyinSubscriptionRecord = {
  id: number;
  bot_id: number;
  chat_id: string;
  click_text: string;
};

export type DouyinClickTextOption = {
  clickText: string;
  updatedAt: string;
};

export type CronField = {
  values: Set<number>;
  unrestricted: boolean;
};

export type PassiveInteractionConfig = {
  reactionRate: number;
  repeatRate: number;
  imageRepeatRate: number;
  imageReverseImageRate: number;
  imageReverseStickerRate: number;
  byteStyleRate: number;
  scaleNewHeightsRate: number;
  imitateRate: number;
  repeatMaxChars: number;
  styleStickerDefaultMaxChars: number;
  styleStickerMaxCharsLimit: number;
  contextSize: number;
  reactionEmojis: string[];
  llmUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmTimeoutMs: number;
  llmMaxTokens: number;
  llmDisableThinking: boolean;
};

export type RecentChatMessage = {
  senderId: string;
  senderName: string;
  text: string;
  createdAt: number;
};

export type ParsedFeishuMessage = {
  messageType: string;
  text: string;
  textForRepeat: string;
  imageKey: string;
  stickerFileKey: string;
};

export type FeishuMessageDetails = {
  messageId: string;
  parentId: string;
  rootId: string;
  threadId: string;
  chatId: string;
  senderId: string;
  senderType: string;
  deleted: boolean;
  message: {
    message_id: string;
    message_type: string;
    content: string;
    mentions?: FeishuMention[];
  };
};

export type DownloadedMessageResource = {
  data: Buffer;
  contentType: string;
  fileName: string;
  filePath: string;
};

export type PassiveMediaResource = {
  sourceType: 'image' | 'sticker';
  fileKey: string;
  resource: DownloadedMessageResource;
};

export type MirroredImageVariant = {
  axis: 'vertical' | 'horizontal';
  sourceSide: 'start' | 'end';
};

export type StyleStickerChatSetting = {
  enabled: boolean;
  rate: number;
  defaultRate: number;
  maxRate: number;
  hasCustomRate: boolean;
  isRateCapped: boolean;
  maxChars: number;
  hasCustomMax: boolean;
  isCapped: boolean;
};

export type PassiveChatSetting = {
  enabled: boolean;
  rate: number;
  defaultRate: number;
  maxRate: number;
  hasCustomRate: boolean;
  isRateCapped: boolean;
};

export type StyleStickerCardAction = 'preview' | 'send' | 'withdraw' | 'hdr';
export type HelpCardAction = 'submit' | 'cancel' | 'withdraw';

export type StyleStickerCardState = {
  feature: StyleStickerFeature;
  text: string;
  color1: string;
  color2: string;
  gradientAngle: number;
  imageKey: string;
  hdrLink?: string;
};

export type HelpRateDescriptor =
  | {
      kind: 'passive';
      feature: PassiveFeature;
      command: string;
      featureName: string;
      formField: string;
    }
  | {
      kind: 'style';
      feature: StyleStickerFeature;
      command: string;
      featureName: string;
      formField: string;
    };

export type HelpMaxDescriptor = {
  feature: StyleStickerFeature;
  command: string;
  featureName: string;
  formField: string;
};

export type TokenCacheEntry = { token: string; expiresAt: number };
