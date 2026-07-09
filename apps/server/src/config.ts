import type { PassiveInteractionConfig } from './types.js';

const DEFAULT_REACTION_EMOJIS = ['OK', 'DONE', 'THUMBSUP', 'HEART', 'LAUGH'];

export function envString(...names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function parseRate(raw: string | undefined, fallback: number) {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

export function parseConfigurableRate(raw: string | undefined) {
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

export function parsePositiveInt(raw: string | undefined, fallback: number) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function parseBooleanFlag(raw: string | undefined, fallback = false) {
  if (!raw?.trim()) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

export function splitCsv(raw: string | undefined, fallback: string[]) {
  const items = (raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function openAIChatCompletionsUrl(url: string) {
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

export function openApiBaseUrl() {
  return (envString('OpenApiBaseUrl', 'DOGEBOT_OPEN_API_BASE_URL', 'OPEN_API_BASE_URL') || 'https://doge.bbyte.cn').replace(/\/+$/, '');
}

export function passiveInteractionConfig(): PassiveInteractionConfig {
  const repeatRate = parseRate(process.env.DOGEBOT_FEISHU_REPEAT_RATE, 0.05);
  const styleStickerDefaultMaxChars = parsePositiveInt(process.env.DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS, 10);
  return {
    reactionRate: parseRate(process.env.DOGEBOT_FEISHU_REACTION_RATE, 0.1),
    repeatRate,
    imageRepeatRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REPEAT_RATE, 0),
    imageReverseImageRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REVERSE_IMAGE_RATE, 0.05),
    imageReverseStickerRate: parseRate(process.env.DOGEBOT_FEISHU_IMAGE_REVERSE_STICKER_RATE, 0.2),
    byteStyleRate: parseRate(process.env.DOGEBOT_FEISHU_BYTE_STYLE_RATE, 0.05),
    scaleNewHeightsRate: parseRate(process.env.DOGEBOT_FEISHU_SCALE_NEW_HEIGHTS_RATE, 0.05),
    imitateRate: parseRate(process.env.DOGEBOT_FEISHU_IMITATE_RATE, 0.05),
    repeatMaxChars: parsePositiveInt(process.env.DOGEBOT_FEISHU_REPEAT_MAX_CHARS, 300),
    styleStickerDefaultMaxChars,
    styleStickerMaxCharsLimit: parsePositiveInt(process.env.DOGEBOT_FEISHU_STYLE_STICKER_MAX_CHARS_LIMIT, 150),
    contextSize: parsePositiveInt(process.env.DOGEBOT_FEISHU_IMITATE_CONTEXT_SIZE, 8),
    reactionEmojis: splitCsv(process.env.DOGEBOT_FEISHU_REACTION_EMOJIS, DEFAULT_REACTION_EMOJIS),
    llmUrl: openAIChatCompletionsUrl(envString('DOGEBOT_LLM_URL', 'DOGEBOT_LLM_BASE_URL', 'OPENAI_BASE_URL', 'OPENAI_API_BASE')),
    llmApiKey: envString('DOGEBOT_LLM_API_KEY', 'OPENAI_API_KEY'),
    llmModel: envString('DOGEBOT_LLM_MODEL', 'OPENAI_MODEL'),
    llmTimeoutMs: parsePositiveInt(envString('DOGEBOT_LLM_TIMEOUT_MS', 'OPENAI_TIMEOUT_MS'), 15_000),
    llmMaxTokens: parsePositiveInt(process.env.DOGEBOT_LLM_MAX_TOKENS, 160),
    llmDisableThinking: parseBooleanFlag(process.env.DOGEBOT_LLM_DISABLE_THINKING)
  };
}

export const pythonTaskConfig = {
  concurrency: parsePositiveInt(process.env.DOGEBOT_PYTHON_TASK_CONCURRENCY, 2),
  queueMax: parsePositiveInt(process.env.DOGEBOT_PYTHON_TASK_QUEUE_MAX, 20),
  timeoutMs: parsePositiveInt(process.env.DOGEBOT_PYTHON_TASK_TIMEOUT_MS, 20_000)
};

export const stickerRenderConfig = {
  concurrency: parsePositiveInt(process.env.DOGEBOT_STYLE_STICKER_RENDER_CONCURRENCY, 2),
  queueMax: parsePositiveInt(process.env.DOGEBOT_STYLE_STICKER_RENDER_QUEUE_MAX, 20),
  timeoutMs: parsePositiveInt(process.env.DOGEBOT_STYLE_STICKER_RENDER_TIMEOUT_MS, 20_000)
};
