#!/usr/bin/env node
import { hostname } from 'node:os';

type CliOptions = {
  serverUrl: string;
  commands: string[];
  token: string;
  username: string;
  password: string;
  clientName: string;
  json: boolean;
  reconnectMinMs: number;
  reconnectMaxMs: number;
};

type SseEvent = {
  event: string;
  data: string;
};

const DEFAULT_SERVER_URL = 'http://127.0.0.1:3000';
const DEFAULT_COMMAND = '/cr';
const COMMAND_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

class UnauthorizedError extends Error {}

function usage() {
  return [
    'Usage:',
    '  dogebot-cli --token <token> [--server http://127.0.0.1:3000] [--command /cr]',
    '  dogebot-cli --username <user> --password <pass> [--server http://127.0.0.1:3000] [--command /cr]',
    '',
    'Options:',
    '  -s, --server <url>       DogeBot server URL. Default: http://127.0.0.1:3000',
    '  -c, --command <command>  Slash command to register. Repeatable. Default: /cr',
    '      --token <token>      Bearer token from /api/login',
    '  -u, --username <user>    Login username, used when token is not provided',
    '  -p, --password <pass>    Login password, used when token is not provided',
    '      --client <name>      Client name shown in server registry',
    '      --json               Print full remote command payload as JSON',
    '      --help               Show this help',
    '',
    'Environment:',
    '  DOGEBOT_SERVER_URL, DOGEBOT_REMOTE_COMMANDS, DOGEBOT_TOKEN,',
    '  DOGEBOT_USERNAME, DOGEBOT_PASSWORD, DOGEBOT_CLIENT_NAME'
  ].join('\n');
}

function readOptionValue(args: string[], index: number, flag: string) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function splitCommands(value: string) {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeCommand(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parsePositiveInt(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv: string[]) {
  const commands = splitCommands(process.env.DOGEBOT_REMOTE_COMMANDS || process.env.DOGEBOT_REMOTE_COMMAND || DEFAULT_COMMAND);
  const options: CliOptions = {
    serverUrl: process.env.DOGEBOT_SERVER_URL || DEFAULT_SERVER_URL,
    commands,
    token: process.env.DOGEBOT_TOKEN || '',
    username: process.env.DOGEBOT_USERNAME || '',
    password: process.env.DOGEBOT_PASSWORD || '',
    clientName: process.env.DOGEBOT_CLIENT_NAME || `dogebot-cli@${hostname()}`,
    json: false,
    reconnectMinMs: 1_000,
    reconnectMaxMs: 30_000
  };
  let commandSpecified = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--server' || arg === '-s') {
      options.serverUrl = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--command' || arg === '-c') {
      if (!commandSpecified) {
        options.commands = [];
        commandSpecified = true;
      }
      options.commands.push(...splitCommands(readOptionValue(argv, index, arg)));
      index += 1;
      continue;
    }
    if (arg === '--token') {
      options.token = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--username' || arg === '-u') {
      options.username = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--password' || arg === '-p') {
      options.password = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--client') {
      options.clientName = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--reconnect-min-ms') {
      options.reconnectMinMs = parsePositiveInt(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === '--reconnect-max-ms') {
      options.reconnectMaxMs = parsePositiveInt(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  options.commands = Array.from(new Set(options.commands.map(normalizeCommand).filter(Boolean)));
  const invalidCommand = options.commands.find((command) => !COMMAND_PATTERN.test(command));
  if (invalidCommand) throw new Error(`invalid command: ${invalidCommand}`);
  if (options.commands.length === 0) throw new Error('at least one command is required');
  if (!options.token && (!options.username || !options.password)) {
    throw new Error('authentication required: provide --token or --username/--password');
  }
  if (options.reconnectMinMs > options.reconnectMaxMs) {
    throw new Error('--reconnect-min-ms must be less than or equal to --reconnect-max-ms');
  }
  return options;
}

function serverUrl(serverUrl: string, path: string) {
  return new URL(path, serverUrl).toString();
}

async function login(options: CliOptions, signal: AbortSignal) {
  const response = await fetch(serverUrl(options.serverUrl, '/api/login'), {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: options.username, password: options.password })
  });
  const data = await response.json().catch(() => ({})) as { token?: string; error?: string };
  if (!response.ok || !data.token) {
    throw new Error(data.error || `login failed: HTTP ${response.status}`);
  }
  return data.token;
}

function parseSseBlock(block: string): SseEvent | undefined {
  const dataLines: string[] = [];
  let event = 'message';
  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separatorIndex = rawLine.indexOf(':');
    const field = separatorIndex >= 0 ? rawLine.slice(0, separatorIndex) : rawLine;
    let value = separatorIndex >= 0 ? rawLine.slice(separatorIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: dataLines.join('\n') };
}

function handleSseEvent(sseEvent: SseEvent, options: CliOptions) {
  const data = JSON.parse(sseEvent.data) as Record<string, unknown>;
  if (sseEvent.event === 'registered') {
    const commands = Array.isArray(data.commands) ? data.commands.join(', ') : options.commands.join(', ');
    console.error(`[dogebot-cli] registered ${commands}`);
    return;
  }
  if (sseEvent.event !== 'remote_command') return;
  if (options.json) {
    console.log(JSON.stringify(data));
    return;
  }
  console.log(typeof data.text === 'string' ? data.text : sseEvent.data);
}

async function readSse(stream: ReadableStream<Uint8Array>, options: CliOptions, signal: AbortSignal) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const abort = () => {
    reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', abort, { once: true });
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const block = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const event = parseSseBlock(block);
        if (event) handleSseEvent(event, options);
        separatorIndex = buffer.indexOf('\n\n');
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

async function connectOnce(options: CliOptions, token: string, signal: AbortSignal) {
  const url = new URL(serverUrl(options.serverUrl, '/api/remote-commands/connect'));
  for (const command of options.commands) url.searchParams.append('command', command);
  url.searchParams.set('client', options.clientName);

  const response = await fetch(url, {
    signal,
    headers: {
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`
    }
  });

  if (response.status === 401) throw new UnauthorizedError('unauthorized');
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`connect failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
  }
  if (!response.body) throw new Error('connect failed: empty response body');

  console.error(`[dogebot-cli] connected to ${options.serverUrl}`);
  await readSse(response.body, options, signal);
  if (!signal.aborted) throw new Error('server closed connection');
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  let token = options.token;
  let attempt = 0;

  while (!controller.signal.aborted) {
    try {
      if (!token) {
        console.error(`[dogebot-cli] logging in as ${options.username}`);
        token = await login(options, controller.signal);
      }
      attempt = 0;
      await connectOnce(options, token, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) break;
      if (error instanceof UnauthorizedError && options.username && options.password) {
        token = '';
      }
      attempt += 1;
      const delayMs = Math.min(options.reconnectMaxMs, options.reconnectMinMs * (2 ** Math.min(attempt - 1, 5)));
      console.error(`[dogebot-cli] ${errorMessage(error)}; reconnecting in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs, controller.signal).catch(() => undefined);
    }
  }
}

run().catch((error) => {
  console.error(`[dogebot-cli] ${errorMessage(error)}`);
  process.exitCode = 1;
});
