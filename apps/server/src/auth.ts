import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { db } from './db.js';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOKEN_RENEW_THRESHOLD_SECONDS = 3 * 24 * 60 * 60;
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

function nowInSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createSession(user: { id: number; username: string }) {
  const now = nowInSeconds();
  const sessionId = randomBytes(24).toString('base64url');
  db.prepare(`
    INSERT INTO auth_sessions (id, user_id, username, expires_at, last_used_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, user.id, user.username, now + TOKEN_TTL_SECONDS, now, now);
  return sessionId;
}

export function createToken(user: { id: number; username: string }): string {
  const payload = base64url(JSON.stringify({ sub: user.id, username: user.username, sid: createSession(user) }));
  return `${payload}.${sign(payload)}`;
}

function verifyLegacyToken(data: { sub: number; username: string; exp: number }) {
  if (!data.sub || !data.username || data.exp < nowInSeconds()) return null;
  return { id: data.sub, username: data.username };
}

function verifySessionToken(data: { sub: number; username: string; sid: string }) {
  if (!data.sub || !data.username || !data.sid) return null;
  const now = nowInSeconds();
  const session = db.prepare(`
    SELECT user_id, username, expires_at
    FROM auth_sessions
    WHERE id = ?
  `).get(data.sid) as { user_id: number; username: string; expires_at: number } | undefined;
  if (!session || session.user_id !== data.sub || session.username !== data.username || session.expires_at < now) {
    return null;
  }
  const nextExpiresAt = session.expires_at - now < TOKEN_RENEW_THRESHOLD_SECONDS ? now + TOKEN_TTL_SECONDS : session.expires_at;
  db.prepare(`
    UPDATE auth_sessions
    SET expires_at = ?, last_used_at = ?
    WHERE id = ?
  `).run(nextExpiresAt, now, data.sid);
  return { id: session.user_id, username: session.username };
}

export function verifyToken(token: string): { id: number; username: string } | null {
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as
      | { sub: number; username: string; exp: number }
      | { sub: number; username: string; sid: string };
    if ('sid' in data) return verifySessionToken(data);
    if ('exp' in data) return verifyLegacyToken(data);
    return null;
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
