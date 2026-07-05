import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { AuthenticatedRequest } from './auth.js';

type RemoteCommandClient = {
  id: string;
  userId: number;
  clientName: string;
  commands: string[];
  registeredAt: string;
  response: Response;
  keepAliveTimer: NodeJS.Timeout;
};

export type RemoteCommandDispatchInput = {
  userId: number | null | undefined;
  text: string;
  bot: {
    id: number;
    name: string;
  };
  message: {
    id: string;
    chatId: string;
    chatType: string;
  };
  sender: {
    id: string;
    name: string;
  };
};

export type RemoteCommandDispatchResult =
  | { handled: false }
  | {
    handled: true;
    command: string;
    delivered: number;
  };

const COMMAND_PATTERN = /^\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const clients = new Map<string, RemoteCommandClient>();
const commandClientIds = new Map<string, Set<string>>();

function queryStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(queryStrings);
  if (typeof value === 'string') return [value];
  return [];
}

function normalizeCommand(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function parseRequestedCommands(req: AuthenticatedRequest) {
  const rawCommands = [
    ...queryStrings(req.query.command),
    ...queryStrings(req.query.commands).flatMap((item) => item.split(','))
  ];
  return Array.from(new Set(rawCommands.map(normalizeCommand).filter(Boolean)));
}

function isValidCommand(command: string) {
  return COMMAND_PATTERN.test(command);
}

function writeSseEvent(response: Response, event: string, payload: unknown) {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`event: ${event}\n`);
    const data = JSON.stringify(payload);
    for (const line of data.split(/\r?\n/)) {
      response.write(`data: ${line}\n`);
    }
    response.write('\n');
    return true;
  } catch {
    return false;
  }
}

function writeSseComment(response: Response, comment: string) {
  if (response.destroyed || response.writableEnded) return false;
  try {
    response.write(`: ${comment}\n\n`);
    return true;
  } catch {
    return false;
  }
}

function addCommandClient(command: string, clientId: string) {
  const ids = commandClientIds.get(command) || new Set<string>();
  ids.add(clientId);
  commandClientIds.set(command, ids);
}

function removeCommandClient(command: string, clientId: string) {
  const ids = commandClientIds.get(command);
  if (!ids) return;
  ids.delete(clientId);
  if (ids.size === 0) commandClientIds.delete(command);
}

function unregisterRemoteCommandClient(clientId: string) {
  const client = clients.get(clientId);
  if (!client) return;
  clients.delete(clientId);
  clearInterval(client.keepAliveTimer);
  for (const command of client.commands) {
    removeCommandClient(command, client.id);
  }
}

export function connectRemoteCommandClient(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const commands = parseRequestedCommands(req);
  if (commands.length === 0) {
    res.status(400).json({ error: 'at least one command is required' });
    return;
  }

  const invalidCommand = commands.find((command) => !isValidCommand(command));
  if (invalidCommand) {
    res.status(400).json({ error: `invalid command: ${invalidCommand}` });
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const now = new Date().toISOString();
  const client: RemoteCommandClient = {
    id: randomUUID(),
    userId: req.user.id,
    clientName: String(req.query.client || 'remote-cli').trim() || 'remote-cli',
    commands,
    registeredAt: now,
    response: res,
    keepAliveTimer: setInterval(() => {
      if (!writeSseComment(res, 'ping')) unregisterRemoteCommandClient(client.id);
    }, 25_000)
  };

  clients.set(client.id, client);
  for (const command of commands) addCommandClient(command, client.id);

  writeSseEvent(res, 'registered', {
    clientId: client.id,
    clientName: client.clientName,
    commands: client.commands,
    registeredAt: client.registeredAt
  });

  req.on('close', () => unregisterRemoteCommandClient(client.id));
  res.on('close', () => unregisterRemoteCommandClient(client.id));
  res.on('error', () => unregisterRemoteCommandClient(client.id));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandIndexInText(text: string, command: string) {
  const match = new RegExp(`(^|\\s)${escapeRegExp(command)}(?=$|\\s)`).exec(text);
  if (!match) return -1;
  return match.index + match[1].length;
}

function clientIdsForCommandAndUser(command: string, userId: number) {
  const ids = commandClientIds.get(command);
  if (!ids) return [];
  return Array.from(ids).filter((id) => clients.get(id)?.userId === userId);
}

function findRemoteCommandMatch(userId: number, text: string) {
  let best: { command: string; index: number } | undefined;
  for (const command of commandClientIds.keys()) {
    if (clientIdsForCommandAndUser(command, userId).length === 0) continue;
    const index = commandIndexInText(text, command);
    if (index < 0) continue;
    if (!best || index < best.index || (index === best.index && command.length > best.command.length)) {
      best = { command, index };
    }
  }
  return best?.command || '';
}

export function dispatchRemoteCommand(input: RemoteCommandDispatchInput): RemoteCommandDispatchResult {
  if (!input.userId) return { handled: false };
  const command = findRemoteCommandMatch(input.userId, input.text);
  if (!command) return { handled: false };

  const payload = {
    command,
    text: input.text,
    receivedAt: new Date().toISOString(),
    bot: input.bot,
    message: input.message,
    sender: input.sender
  };

  let delivered = 0;
  for (const clientId of clientIdsForCommandAndUser(command, input.userId)) {
    const client = clients.get(clientId);
    if (!client) continue;
    if (writeSseEvent(client.response, 'remote_command', payload)) {
      delivered += 1;
    } else {
      unregisterRemoteCommandClient(client.id);
    }
  }

  return { handled: true, command, delivered };
}

export function listRemoteCommandClients(req: AuthenticatedRequest, res: Response) {
  if (!req.user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  res.json({
    clients: Array.from(clients.values())
      .filter((client) => client.userId === req.user?.id)
      .map((client) => ({
        id: client.id,
        clientName: client.clientName,
        commands: client.commands,
        registeredAt: client.registeredAt
      }))
  });
}
