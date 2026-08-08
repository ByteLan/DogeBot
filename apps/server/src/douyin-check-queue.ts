import { parsePositiveInt, parsePositiveNumber } from './config.js';

/**
 * Global throttle for Douyin validity probes.
 *
 * Every entry point (feishu keyword / command / subscription push / cron /
 * open-api) funnels its network probe through {@link enqueueDouyinCheck}, so a
 * single scheduler here bounds how hard we hit Douyin's servers regardless of
 * how many callers fire at once.
 *
 * Two gates apply to each task before it runs:
 *  - concurrency: at most `DOGEBOT_DOUYIN_CHECK_CONCURRENCY` probes in flight
 *    (default 1 = serial).
 *  - QPS: at least `1000 / DOGEBOT_DOUYIN_CHECK_QPS` ms between two releases
 *    (default 1 = one probe per second), smoothing the rate instead of
 *    releasing a whole second's budget in a burst. QPS may be fractional, e.g.
 *    0.5 = one probe every two seconds.
 *
 * In-flight de-duplication: while a probe for an aweme_id is queued or running,
 * a second call for the same id reuses the same promise instead of enqueuing a
 * duplicate. This collapses the "each subscribed group re-checks the same new
 * video" fan-out into a single network request.
 */

export const douyinCheckQueueConfig = {
  concurrency: parsePositiveInt(process.env.DOGEBOT_DOUYIN_CHECK_CONCURRENCY, 1),
  qps: parsePositiveNumber(process.env.DOGEBOT_DOUYIN_CHECK_QPS, 1),
  queueMax: parsePositiveInt(process.env.DOGEBOT_DOUYIN_CHECK_QUEUE_MAX, 0)
};

const minIntervalMs = douyinCheckQueueConfig.qps > 0 ? Math.ceil(1000 / douyinCheckQueueConfig.qps) : 0;
const maxQueue = douyinCheckQueueConfig.queueMax > 0 ? douyinCheckQueueConfig.queueMax : Infinity;

export class DouyinCheckQueueFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DouyinCheckQueueFullError';
  }
}

type QueuedItem = {
  awemeId: string;
  enqueuedAt: number;
  run: () => void;
};

const inFlight = new Map<string, Promise<unknown>>();
/** How many duplicate calls were merged into each in-flight id (for reuse logging). */
const reuseCounts = new Map<string, number>();
const waiting: QueuedItem[] = [];
let active = 0;
let lastReleaseAt = 0;
let releaseTimer: ReturnType<typeof setTimeout> | undefined;

function snapshot() {
  return { waiting: waiting.length, active, inFlight: inFlight.size };
}

function log(event: string, extra: Record<string, unknown> = {}) {
  console.log(`[douyin-check-queue] ${event}`, { ...extra, ...snapshot() });
}

log('config', {
  concurrency: douyinCheckQueueConfig.concurrency,
  qps: douyinCheckQueueConfig.qps,
  minIntervalMs,
  queueMax: maxQueue === Infinity ? 'unlimited' : maxQueue
});

function pump() {
  if (releaseTimer) return;
  if (active >= douyinCheckQueueConfig.concurrency) return;
  const next = waiting[0];
  if (!next) return;

  const now = Date.now();
  const wait = minIntervalMs > 0 ? Math.max(0, lastReleaseAt + minIntervalMs - now) : 0;
  if (wait > 0) {
    releaseTimer = setTimeout(() => {
      releaseTimer = undefined;
      pump();
    }, wait);
    return;
  }

  waiting.shift();
  active++;
  lastReleaseAt = Date.now();
  log('start', { awemeId: next.awemeId, waitedMs: lastReleaseAt - next.enqueuedAt });
  next.run();
  // A single release may have freed room for another concurrent slot.
  pump();
}

/**
 * Enqueue a Douyin probe under the global concurrency + QPS gates, de-duplicated
 * by aweme_id. `worker` should perform the actual network probe (and any cache
 * write); it is invoked at most once per in-flight id.
 *
 * Throws {@link DouyinCheckQueueFullError} synchronously (rejected promise) when
 * the queue is full — callers treat this as an inconclusive probe so a video is
 * never deleted just because we were overloaded.
 */
export function enqueueDouyinCheck<T>(awemeId: string, worker: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(awemeId);
  if (existing) {
    const reuseCount = (reuseCounts.get(awemeId) ?? 0) + 1;
    reuseCounts.set(awemeId, reuseCount);
    log('reuse', { awemeId, reuseCount });
    return existing as Promise<T>;
  }

  if (waiting.length >= maxQueue) {
    log('reject', { awemeId, reason: 'queue-full', maxQueue });
    return Promise.reject(new DouyinCheckQueueFullError(`douyin check queue full (max=${maxQueue})`));
  }

  const promise = new Promise<T>((resolve, reject) => {
    waiting.push({
      awemeId,
      enqueuedAt: Date.now(),
      run: () => {
        const startedAt = Date.now();
        Promise.resolve()
          .then(worker)
          .then(
            (value) => {
              log('settle', {
                awemeId,
                status: 'ok',
                durationMs: Date.now() - startedAt,
                reuseCount: reuseCounts.get(awemeId) ?? 0
              });
              resolve(value);
            },
            (error) => {
              log('settle', {
                awemeId,
                status: 'error',
                durationMs: Date.now() - startedAt,
                reuseCount: reuseCounts.get(awemeId) ?? 0,
                error: error instanceof Error ? error.message : String(error)
              });
              reject(error);
            }
          )
          .finally(() => {
            active--;
            inFlight.delete(awemeId);
            reuseCounts.delete(awemeId);
            pump();
          });
      }
    });
    log('enqueue', { awemeId });
    pump();
  });

  inFlight.set(awemeId, promise);
  return promise;
}
