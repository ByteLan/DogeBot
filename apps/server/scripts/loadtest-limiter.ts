#!/usr/bin/env node
/*
 * Unit-style load test for the concurrency limiter itself.
 *
 * Bypasses the HTTP layer (which can't demonstrate queue depth for
 * CPU-bound handlers) and exercises the limiter directly with async
 * sleep-based tasks. Proves:
 *   - concurrent scheduling with limit slots
 *   - queue depth growing beyond limit
 *   - QUEUE_FULL rejection when queue exceeds maxQueue
 *   - TASK_TIMEOUT firing when a task exceeds taskTimeoutMs
 *
 * Run:
 *   ./node_modules/.bin/tsx apps/server/scripts/loadtest-limiter.ts
 */
import { createConcurrencyLimiter, ConcurrencyLimiterError } from '../src/concurrency.js';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type TaskResult =
  | { id: string | number; ok: true; value: unknown }
  | { id: string | number; ok: false; code: string; message?: string };

async function scenarioQueueingAndRejection() {
  console.log('\n===== scenario 1: queueing + QUEUE_FULL =====');
  const runLimited = createConcurrencyLimiter({
    name: 'demo-queueing',
    limit: 2,
    maxQueue: 5,
    taskTimeoutMs: 60_000
  });

  const submit = (id: number): Promise<TaskResult> =>
    runLimited(async () => {
      await sleep(500);
      return id;
    }).then<TaskResult, TaskResult>(
      (value) => ({ id, ok: true, value }),
      (error) => ({
        id,
        ok: false,
        code: error instanceof ConcurrencyLimiterError ? error.code : 'UNKNOWN',
        message: error?.message
      })
    );

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => submit(i)));
  const ok = results.filter((r) => r.ok).length;
  const queueFull = results.filter((r): r is Extract<TaskResult, { ok: false }> => !r.ok && r.code === 'QUEUE_FULL').length;
  const other = results.length - ok - queueFull;
  console.log(`summary: ok=${ok} queueFull=${queueFull} otherError=${other}`);
}

async function scenarioTaskTimeout() {
  console.log('\n===== scenario 2: TASK_TIMEOUT =====');
  const runLimited = createConcurrencyLimiter({
    name: 'demo-timeout',
    limit: 1,
    maxQueue: 5,
    taskTimeoutMs: 300
  });

  const slowTask = runLimited(async (signal) => {
    for (let i = 0; i < 10; i += 1) {
      if (signal?.aborted) throw new Error('aborted');
      await sleep(100);
    }
    return 'done';
  }).then<TaskResult, TaskResult>(
    (value) => ({ id: 'slow', ok: true, value }),
    (error) => ({
      id: 'slow',
      ok: false,
      code: error instanceof ConcurrencyLimiterError ? error.code : 'UNKNOWN',
      message: error?.message
    })
  );
  const followUp = runLimited(async () => {
    await sleep(50);
    return 'follow-up';
  }).then<TaskResult, TaskResult>(
    (value) => ({ id: 'follow-up', ok: true, value }),
    (error) => ({
      id: 'follow-up',
      ok: false,
      code: error instanceof ConcurrencyLimiterError ? error.code : 'UNKNOWN',
      message: error?.message
    })
  );
  const results = await Promise.all([slowTask, followUp]);
  console.log('results:', results);
}

async function scenarioBackpressure() {
  console.log('\n===== scenario 3: mixed load with timeout + queue-full =====');
  const runLimited = createConcurrencyLimiter({
    name: 'demo-mixed',
    limit: 2,
    maxQueue: 3,
    taskTimeoutMs: 400
  });

  const submit = (id: string, workMs: number): Promise<TaskResult> =>
    runLimited(async (signal) => {
      const step = 50;
      for (let elapsed = 0; elapsed < workMs; elapsed += step) {
        if (signal?.aborted) throw new Error('aborted');
        await sleep(Math.min(step, workMs - elapsed));
      }
      return id;
    }).then<TaskResult, TaskResult>(
      (value) => ({ id, ok: true, value }),
      (error) => ({
        id,
        ok: false,
        code: error instanceof ConcurrencyLimiterError ? error.code : 'UNKNOWN',
        message: error?.message
      })
    );

  const submissions = [
    submit('slow-0', 1000),
    submit('slow-1', 1000),
    submit('quick-2', 100),
    submit('quick-3', 100),
    submit('quick-4', 100),
    submit('overflow-5', 100),
    submit('overflow-6', 100)
  ];
  const results = await Promise.all(submissions);
  console.log('results:', results);
}

async function main() {
  await scenarioQueueingAndRejection();
  await scenarioTaskTimeout();
  await scenarioBackpressure();
}

main().catch((error) => {
  console.error('[loadtest-limiter] failed', error);
  process.exit(1);
});
