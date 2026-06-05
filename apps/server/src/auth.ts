import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.js';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const authSecret = process.env.DOGEBOT_AUTH_SECRET || 'dogebot-dev-secret-change-me';

export type AuthenticatedRequest = Request & { user?: { id: number; username: string } };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(input: string): string {
  return createHmac('sha256', authSecret).update(input).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = pbkdf2Sync(password, salt, 210_000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createToken(user: { id: number; username: string }): string {
  const payload = base64url(JSON.stringify({ sub: user.id, username: user.username, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): { id: number; username: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: number; username: string; exp: number };
    if (!data.sub || !data.username || data.exp < Math.floor(Date.now() / 1000)) return null;
    return { id: data.sub, username: data.username };
  } catch {
    return null;
  }
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const user = token ? verifyToken(token) : null;
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next();
}

export function addUser(username: string, password: string) {
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)').run(username, hash, salt);
}

export function authenticate(username: string, password: string) {
  const row = db.prepare('SELECT id, username, password_hash, salt FROM users WHERE username = ?').get(username) as
    | { id: number; username: string; password_hash: string; salt: string }
    | undefined;
  if (!row || !verifyPassword(password, row.salt, row.password_hash)) return null;
  return { id: row.id, username: row.username };
}
