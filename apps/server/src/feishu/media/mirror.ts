import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { FeishuBot, MirroredImageVariant, PassiveMediaResource } from '../../types.js';
import { pythonTaskConfig } from '../../config.js';
import { createConcurrencyLimiter } from '../../utils/concurrency.js';
import { uploadImage, sendImageToChat } from '../api.js';
import { guessExtensionFromContentType, MESSAGE_RESOURCE_PROCESSED_DIR, sanitizeCacheSegment, sanitizeFileKeyForCache } from './resource-cache.js';

const execFileAsync = promisify(execFile);
const moduleDir = dirname(fileURLToPath(import.meta.url));
const appDir = dirname(dirname(dirname(moduleDir)));
const appRootDir = appDir.endsWith('/dist') ? dirname(appDir) : appDir;

function resolveRuntimeScriptPath(fileName: string) {
  const candidates = [
    join(appDir, 'scripts', fileName),
    join(appRootDir, 'scripts', fileName)
  ];
  const matched = candidates.find((candidate) => existsSync(candidate));
  return matched || candidates[0];
}

const IMAGE_MIRROR_SCRIPT_PATH = resolveRuntimeScriptPath('mirror-image.py');

const runPythonTask = createConcurrencyLimiter({
  name: 'python-task',
  limit: pythonTaskConfig.concurrency,
  maxQueue: pythonTaskConfig.queueMax,
  taskTimeoutMs: pythonTaskConfig.timeoutMs
});

async function ensureProcessedMediaDir() {
  await fs.mkdir(MESSAGE_RESOURCE_PROCESSED_DIR, { recursive: true });
}

function buildProcessedMediaFileNameWithExtension(
  fileKey: string,
  sourceType: 'image' | 'sticker',
  chatId: string,
  variant: MirroredImageVariant,
  extension: string,
  timestamp = Date.now()
) {
  const sourceMarker = sanitizeCacheSegment(sourceType, 'unknown');
  const chatMarker = sanitizeCacheSegment(chatId, 'unknown_chat');
  return `ts=${timestamp}--src=${sourceMarker}--chat=${chatMarker}--key=${sanitizeFileKeyForCache(fileKey)}--fx=mirror-${variant.axis}-${variant.sourceSide}${extension}`;
}

export function randomMirrorVariant(): MirroredImageVariant {
  return {
    axis: Math.random() < 0.5 ? 'vertical' : 'horizontal',
    sourceSide: Math.random() < 0.5 ? 'start' : 'end'
  };
}

export async function buildMirroredImage(resource: PassiveMediaResource, chatId: string) {
  await ensureProcessedMediaDir();
  const variant = randomMirrorVariant();
  const outputExtension = extname(resource.resource.fileName) || guessExtensionFromContentType(resource.resource.contentType, '.png');
  const outputPath = join(MESSAGE_RESOURCE_PROCESSED_DIR, buildProcessedMediaFileNameWithExtension(resource.fileKey, resource.sourceType, chatId, variant, outputExtension));
  await runPythonTask((signal) =>
    execFileAsync('python3', [IMAGE_MIRROR_SCRIPT_PATH, resource.resource.filePath, outputPath, variant.axis, variant.sourceSide], {
      maxBuffer: 1024 * 1024,
      signal
    })
  );
  return {
    variant,
    filePath: outputPath,
    fileName: basename(outputPath),
    data: await fs.readFile(outputPath)
  };
}

export async function sendMirroredMediaResource(bot: FeishuBot, chatId: string, media: PassiveMediaResource) {
  let transformed: { variant: MirroredImageVariant; filePath: string; fileName: string; data: Buffer } | undefined;
  try {
    transformed = await buildMirroredImage(media, chatId);
    const uploadedImageKey = await uploadImage(bot, transformed.data, transformed.fileName);
    await sendImageToChat(bot, chatId, uploadedImageKey);
  } finally {
    if (transformed?.filePath) {
      await fs.unlink(transformed.filePath).catch(() => undefined);
    }
  }
}
