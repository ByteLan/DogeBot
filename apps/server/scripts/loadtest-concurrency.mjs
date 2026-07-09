#!/usr/bin/env node
/*
 * Concurrency load test for /open-api/v1/byte-style.
 *
 * Fires N concurrent GET requests and reports per-request outcome plus a
 * summary. Combined with server logs ([concurrency:style-sticker-render] ...)
 * this proves the limiter is queueing, timing out, and rejecting as expected.
 *
 * Uses the raw node:http module with explicit `Connection: close` so every
 * request goes over its own TCP socket. This bypasses undici's default
 * keep-alive pool (which would serialize requests over one socket and make
 * the server see requests one-by-one).
 *
 * Usage:
 *   node apps/server/scripts/loadtest-concurrency.mjs \
 *     [--url http://127.0.0.1:3300/open-api/v1/byte-style] \
 *     [--count 25] [--text hello]
 */
import http from 'node:http';
import { URL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  const value = process.argv[i + 1];
  if (key) args.set(key, value);
}

const rawUrl = args.get('url') || 'http://127.0.0.1:3300/open-api/v1/byte-style';
const count = Number(args.get('count') || 25);
const text = args.get('text') || 'loadtest';

function fireOne(index) {
  const target = new URL(rawUrl);
  target.searchParams.set('text', `${text}-${index}`);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const req = http.request(
      {
        method: 'GET',
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        headers: { Connection: 'close' },
        agent: false
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const durationMs = Date.now() - startedAt;
          const buf = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';
          let payload;
          if (contentType.startsWith('application/json')) {
            try { payload = JSON.parse(buf.toString('utf8')); }
            catch { payload = { raw: buf.toString('utf8') }; }
          } else {
            payload = { bytes: buf.byteLength };
          }
          resolve({ index, status: res.statusCode ?? 0, durationMs, payload });
        });
      }
    );
    req.on('error', (error) => {
      resolve({
        index,
        status: 0,
        durationMs: Date.now() - startedAt,
        payload: { error: error instanceof Error ? error.message : String(error) }
      });
    });
    req.end();
  });
}

async function main() {
  console.log(`[loadtest] firing ${count} concurrent requests to ${rawUrl}`);
  const overallStart = Date.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => fireOne(index))
  );
  const totalMs = Date.now() - overallStart;

  results.sort((a, b) => a.index - b.index);

  const buckets = { ok: 0, queueFull: 0, timeout: 0, otherError: 0 };
  for (const result of results) {
    const errorMsg = typeof result.payload?.error === 'string' ? result.payload.error : '';
    if (result.status === 200) buckets.ok += 1;
    else if (errorMsg.includes('queue full')) buckets.queueFull += 1;
    else if (errorMsg.includes('exceeded')) buckets.timeout += 1;
    else buckets.otherError += 1;
    console.log(
      `[loadtest] #${String(result.index).padStart(2, ' ')} status=${result.status} duration=${result.durationMs}ms payload=${
        result.status === 200
          ? `image(${result.payload?.bytes ?? '?'} bytes)`
          : JSON.stringify(result.payload)
      }`
    );
  }
  console.log(
    `[loadtest] done in ${totalMs}ms: ok=${buckets.ok} queueFull=${buckets.queueFull} timeout=${buckets.timeout} otherError=${buckets.otherError}`
  );
}

main().catch((error) => {
  console.error('[loadtest] failed', error);
  process.exit(1);
});
