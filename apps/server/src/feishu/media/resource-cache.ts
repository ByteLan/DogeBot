import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import type { FeishuBot, DownloadedMessageResource, ParsedFeishuMessage, PassiveMediaResource } from '../../types.js';
import { parsePositiveInt } from '../../config.js';
import { tenantAccessToken, openBase } from '../client.js';

export const MESSAGE_RESOURCE_MAX_BYTES = parsePositiveInt(process.env.DOGEBOT_FEISHU_MESSAGE_RESOURCE_MAX_BYTES, 4 * 1024 * 1024);
export const MESSAGE_RESOURCE_CACHE_DIR = join(tmpdir(), 'dogebot-feishu-image-cache');
export const MESSAGE_RESOURCE_PROCESSED_DIR = join(tmpdir(), 'dogebot-feishu-image-processed');
export const MESSAGE_RESOURCE_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const MESSAGE_RESOURCE_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const messageResourceCache = new Map<string, string>();
const messageResourceDownloads = new Map<string, Promise<DownloadedMessageResource>>();
let messageResourceCacheCleanupTimer: NodeJS.Timeout | undefined;

export function guessExtensionFromContentType(contentType: string, fallback = '.bin') {
  const normalized = contentType.split(';')[0].trim().toLowerCase();
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  if (normalized === 'image/heic') return '.heic';
  if (normalized === 'image/heif') return '.heif';
  if (normalized === 'image/tiff') return '.tiff';
  return fallback;
}

export function guessContentTypeFromFileName(fileName: string) {
  const normalized = extname(fileName).toLowerCase();
  if (normalized === '.png') return 'image/png';
  if (normalized === '.jpg' || normalized === '.jpeg') return 'image/jpeg';
  if (normalized === '.webp') return 'image/webp';
  if (normalized === '.gif') return 'image/gif';
  if (normalized === '.heic') return 'image/heic';
  if (normalized === '.heif') return 'image/heif';
  if (normalized === '.tiff' || normalized === '.tif') return 'image/tiff';
  return 'application/octet-stream';
}

function buildMessageResourceUrl(domain: string, messageId: string, fileKey: string, type: 'image' | 'file') {
  return `${openBase(domain)}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`;
}

export function sanitizeFileKeyForCache(fileKey: string) {
  return fileKey.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

export function sanitizeCacheSegment(value: string, fallback: string) {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || fallback;
}

function buildCachedResourceFileName(fileKey: string, sourceType: 'image' | 'sticker', chatId: string, extension: string, timestamp = Date.now()) {
  const sourceMarker = sanitizeCacheSegment(sourceType, 'unknown');
  const chatMarker = sanitizeCacheSegment(chatId, 'unknown_chat');
  return `ts=${timestamp}--src=${sourceMarker}--chat=${chatMarker}--key=${sanitizeFileKeyForCache(fileKey)}${extension}`;
}

function cacheKeyMarker(fileKey: string) {
  return `--key=${sanitizeFileKeyForCache(fileKey)}`;
}

function cacheTimestampFromFileName(fileName: string) {
  const matchedTimestamp = fileName.match(/^ts=(\d+)--/);
  const timestamp = Number(matchedTimestamp?.[1] || '');
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

async function ensureMessageResourceCacheDir() {
  await fs.mkdir(MESSAGE_RESOURCE_CACHE_DIR, { recursive: true });
  if (!messageResourceCacheCleanupTimer) {
    messageResourceCacheCleanupTimer = setInterval(() => {
      cleanupExpiredCachedResources().catch((error) => {
        console.error('[feishu] cached resource cleanup failed', error);
      });
    }, MESSAGE_RESOURCE_CACHE_CLEANUP_INTERVAL_MS);
    messageResourceCacheCleanupTimer.unref?.();
    await cleanupExpiredCachedResources().catch((error) => {
      console.error('[feishu] cached resource initial cleanup failed', error);
    });
  }
}

async function cleanupExpiredCachedResources(now = Date.now()) {
  await fs.mkdir(MESSAGE_RESOURCE_CACHE_DIR, { recursive: true });
  const entries = await fs.readdir(MESSAGE_RESOURCE_CACHE_DIR).catch(() => []);
  for (const entry of entries) {
    const timestamp = cacheTimestampFromFileName(entry);
    if (!timestamp || now - timestamp <= MESSAGE_RESOURCE_CACHE_TTL_MS) continue;
    const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, entry);
    await fs.unlink(filePath).catch(() => undefined);
    for (const [fileKey, cachedFileName] of messageResourceCache) {
      if (cachedFileName === entry) messageResourceCache.delete(fileKey);
    }
  }
}

async function findCachedResourcePath(fileKey: string) {
  await ensureMessageResourceCacheDir();
  const cachedFileName = messageResourceCache.get(fileKey);
  if (cachedFileName) {
    const cachedPath = join(MESSAGE_RESOURCE_CACHE_DIR, cachedFileName);
    const stats = await fs.stat(cachedPath).catch(() => undefined);
    if (stats?.isFile()) {
      if (stats.size >= MESSAGE_RESOURCE_MAX_BYTES) {
        await fs.unlink(cachedPath).catch(() => undefined);
        messageResourceCache.delete(fileKey);
      } else {
        return cachedPath;
      }
    } else {
      messageResourceCache.delete(fileKey);
    }
  }

  const marker = cacheKeyMarker(fileKey);
  const entries = await fs.readdir(MESSAGE_RESOURCE_CACHE_DIR).catch(() => []);
  const matched = entries
    .filter((entry) => entry.includes(marker))
    .sort((left, right) => cacheTimestampFromFileName(right) - cacheTimestampFromFileName(left));
  for (const entry of matched) {
    const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, entry);
    const stats = await fs.stat(filePath).catch(() => undefined);
    if (!stats?.isFile()) continue;
    if (stats.size >= MESSAGE_RESOURCE_MAX_BYTES) {
      await fs.unlink(filePath).catch(() => undefined);
      continue;
    }
    messageResourceCache.set(fileKey, entry);
    return filePath;
  }
  return '';
}

async function refreshCachedResourceTimestamp(fileKey: string, filePath: string) {
  const currentName = basename(filePath);
  if (!/^ts=\d+--/.test(currentName)) return filePath;
  const nextName = currentName.replace(/^ts=\d+--/, `ts=${Date.now()}--`);
  const nextPath = join(MESSAGE_RESOURCE_CACHE_DIR, nextName);
  if (nextPath === filePath) {
    messageResourceCache.set(fileKey, basename(filePath));
    return filePath;
  }
  await fs.rename(filePath, nextPath).catch(async () => {
    await fs.copyFile(filePath, nextPath);
    await fs.unlink(filePath).catch(() => undefined);
  });
  messageResourceCache.set(fileKey, basename(nextPath));
  return nextPath;
}

async function loadCachedMessageResource(fileKey: string): Promise<DownloadedMessageResource | undefined> {
  const cachedPath = await findCachedResourcePath(fileKey);
  if (!cachedPath) return undefined;
  const refreshedPath = await refreshCachedResourceTimestamp(fileKey, cachedPath);
  const data = await fs.readFile(refreshedPath);
  return {
    data,
    contentType: guessContentTypeFromFileName(refreshedPath),
    fileName: basename(refreshedPath),
    filePath: refreshedPath
  };
}

async function saveCachedMessageResource(fileKey: string, data: Buffer, contentType: string, sourceType: 'image' | 'sticker', chatId: string) {
  await ensureMessageResourceCacheDir();
  const extension = guessExtensionFromContentType(contentType, '.bin');
  const filePath = join(MESSAGE_RESOURCE_CACHE_DIR, buildCachedResourceFileName(fileKey, sourceType, chatId, extension));
  await fs.writeFile(filePath, data);
  messageResourceCache.set(fileKey, basename(filePath));
  return filePath;
}

async function probeMessageResourceSize(bot: FeishuBot, messageId: string, fileKey: string, type: 'image' | 'file') {
  const token = await tenantAccessToken(bot);
  const url = buildMessageResourceUrl(bot.domain, messageId, fileKey, type);
  const authHeader = { authorization: `Bearer ${token}` };
  const headResponse = await fetch(url, { method: 'HEAD', headers: authHeader }).catch(() => undefined);
  const headContentLength = Number(headResponse?.headers.get('content-length') || '');
  if (headResponse?.ok && Number.isFinite(headContentLength) && headContentLength >= 0) {
    return headContentLength;
  }

  const rangeResponse = await fetch(url, {
    method: 'GET',
    headers: { ...authHeader, range: 'bytes=0-0' }
  });
  if (!rangeResponse.ok) {
    const errorBody = await rangeResponse.text().catch(() => '');
    throw new Error(`probe message resource size failed: ${rangeResponse.status} ${errorBody}`.trim());
  }
  const contentRange = rangeResponse.headers.get('content-range') || '';
  const matchedTotal = contentRange.match(/\/(\d+)$/);
  const fallbackContentLength = Number(rangeResponse.headers.get('content-length') || '');
  await rangeResponse.body?.cancel().catch(() => undefined);
  if (matchedTotal) return Number(matchedTotal[1]);
  if (rangeResponse.status === 200 && Number.isFinite(fallbackContentLength) && fallbackContentLength >= 0) {
    return fallbackContentLength;
  }
  return 0;
}

async function readResponseBufferWithinLimit(response: globalThis.Response, maxBytes: number, fileKey: string) {
  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength >= maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`message resource too large while downloading: ${contentLength} bytes (${fileKey})`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length >= maxBytes) {
      throw new Error(`message resource too large while downloading: ${data.length} bytes (${fileKey})`);
    }
    return data;
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes >= maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`message resource too large while downloading: ${totalBytes} bytes (${fileKey})`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, totalBytes);
}

async function downloadMessageResourceUncached(
  bot: FeishuBot,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  sourceType: 'image' | 'sticker',
  chatId: string
): Promise<DownloadedMessageResource> {
  const token = await tenantAccessToken(bot);
  const response = await fetch(buildMessageResourceUrl(bot.domain, messageId, fileKey, type), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`download message resource failed: ${response.status} ${errorBody}`.trim());
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const data = await readResponseBufferWithinLimit(response, MESSAGE_RESOURCE_MAX_BYTES, fileKey);
  const filePath = await saveCachedMessageResource(fileKey, data, contentType, sourceType, chatId);
  return {
    data,
    contentType,
    fileName: basename(filePath),
    filePath
  };
}

export async function downloadMessageResource(
  bot: FeishuBot,
  messageId: string,
  fileKey: string,
  type: 'image' | 'file',
  sourceType: 'image' | 'sticker',
  chatId: string
): Promise<DownloadedMessageResource> {
  const cacheKey = `${type}:${fileKey}`;
  const inflight = messageResourceDownloads.get(cacheKey);
  if (inflight) return inflight;

  const task = (async () => {
    const cached = await loadCachedMessageResource(fileKey);
    if (cached) return cached;

    const size = await probeMessageResourceSize(bot, messageId, fileKey, type);
    if (Number.isFinite(size) && size > 0 && size >= MESSAGE_RESOURCE_MAX_BYTES) {
      throw new Error(`message resource too large: ${size} bytes`);
    }
    return downloadMessageResourceUncached(bot, messageId, fileKey, type, sourceType, chatId);
  })();

  messageResourceDownloads.set(cacheKey, task);
  try {
    return await task;
  } finally {
    messageResourceDownloads.delete(cacheKey);
  }
}

export async function resolvePassiveMediaResource(bot: FeishuBot, messageId: string, chatId: string, parsedMessage: ParsedFeishuMessage): Promise<PassiveMediaResource | undefined> {
  if (parsedMessage.imageKey) {
    const resource = await downloadMessageResource(bot, messageId, parsedMessage.imageKey, 'image', 'image', chatId);
    return {
      sourceType: 'image',
      fileKey: parsedMessage.imageKey,
      resource
    };
  }
  if (!parsedMessage.stickerFileKey) return undefined;
  try {
    const resource = await downloadMessageResource(bot, messageId, parsedMessage.stickerFileKey, 'file', 'sticker', chatId);
    return {
      sourceType: 'sticker',
      fileKey: parsedMessage.stickerFileKey,
      resource
    };
  } catch (error) {
    console.warn('[feishu] passive sticker media resource is unavailable', {
      botId: bot.id,
      messageId,
      chatId,
      stickerFileKey: parsedMessage.stickerFileKey,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}
