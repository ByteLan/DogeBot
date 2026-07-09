export type ConcurrencyLimiterErrorCode = 'QUEUE_FULL' | 'TASK_TIMEOUT';

export class ConcurrencyLimiterError extends Error {
  readonly code: ConcurrencyLimiterErrorCode;
  constructor(code: ConcurrencyLimiterErrorCode, message: string) {
    super(message);
    this.name = 'ConcurrencyLimiterError';
    this.code = code;
  }
}

export type ConcurrencyLimiterOptions = {
  name?: string;
  limit: number;
  maxQueue?: number;
  taskTimeoutMs?: number;
};

export type LimitedTask<T> = (signal?: AbortSignal) => Promise<T> | T;

type WaitingItem = { id: number; enqueuedAt: number; start: () => void };

export function createConcurrencyLimiter(options: ConcurrencyLimiterOptions) {
  const name = options.name ?? 'anonymous';
  const normalizedLimit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 1;
  const maxQueue =
    typeof options.maxQueue === 'number' && Number.isInteger(options.maxQueue) && options.maxQueue > 0
      ? options.maxQueue
      : Infinity;
  const taskTimeoutMs =
    typeof options.taskTimeoutMs === 'number' && Number.isInteger(options.taskTimeoutMs) && options.taskTimeoutMs > 0
      ? options.taskTimeoutMs
      : 0;

  const waiting: WaitingItem[] = [];
  const active = new Map<number, number>();
  let nextTaskId = 0;

  function snapshot() {
    const now = Date.now();
    return {
      total: active.size + waiting.length,
      active: active.size,
      waiting: waiting.length,
      activeDurationsMs: Array.from(active.values(), (startedAt) => now - startedAt),
      waitingDurationsMs: waiting.map((item) => now - item.enqueuedAt)
    };
  }

  function log(event: string, extra: Record<string, unknown> = {}) {
    console.log(`[concurrency:${name}] ${event}`, { ...extra, ...snapshot() });
  }

  function tryStartNext() {
    if (active.size >= normalizedLimit) return;
    const next = waiting.shift();
    if (!next) return;
    active.set(next.id, Date.now());
    next.start();
  }

  return function runWithLimit<T>(task: LimitedTask<T>): Promise<T> {
    const taskId = nextTaskId++;
    return new Promise<T>((resolve, reject) => {
      if (waiting.length >= maxQueue) {
        log('reject', { taskId, reason: 'queue-full', maxQueue });
        reject(new ConcurrencyLimiterError('QUEUE_FULL', `concurrency queue full (max=${maxQueue})`));
        return;
      }

      const controller = taskTimeoutMs > 0 ? new AbortController() : undefined;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const item: WaitingItem = {
        id: taskId,
        enqueuedAt: Date.now(),
        start: () => {
          const startedAt = active.get(taskId) ?? Date.now();
          const waitedMs = startedAt - item.enqueuedAt;
          log('start', { taskId, waitedMs });

          if (taskTimeoutMs > 0) {
            timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              controller?.abort();
              const durationMs = Date.now() - startedAt;
              active.delete(taskId);
              log('timeout', { taskId, durationMs });
              reject(new ConcurrencyLimiterError('TASK_TIMEOUT', `concurrency task exceeded ${taskTimeoutMs}ms`));
              tryStartNext();
            }, taskTimeoutMs);
          }

          Promise.resolve()
            .then(() => task(controller?.signal))
            .then(
              (value) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                const durationMs = Date.now() - startedAt;
                active.delete(taskId);
                log('settle', { taskId, status: 'ok', durationMs });
                resolve(value);
                tryStartNext();
              },
              (error) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                const durationMs = Date.now() - startedAt;
                active.delete(taskId);
                log('settle', {
                  taskId,
                  status: 'error',
                  durationMs,
                  error: error instanceof Error ? error.message : String(error)
                });
                reject(error);
                tryStartNext();
              }
            );
        }
      };

      waiting.push(item);
      log('enqueue', { taskId });
      tryStartNext();
    });
  };
}
