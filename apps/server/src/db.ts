import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = process.env.DOGEBOT_DATA_DIR || join(appDir, 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new Database(join(dataDir, 'dogebot.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS feishu_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    app_id TEXT NOT NULL,
    app_secret TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT 'feishu',
    verification_token TEXT NOT NULL DEFAULT '',
    encrypt_key TEXT NOT NULL DEFAULT '',
    bot_name TEXT,
    bot_open_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS at_users_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    at_by TEXT NOT NULL,
    at_by_name TEXT NOT NULL DEFAULT '',
    at_who TEXT NOT NULL,
    at_who_name TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    deleted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(bot_id, at_by, at_who)
  );

  CREATE TABLE IF NOT EXISTS douyin_aweme_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    click_text TEXT NOT NULL,
    aweme_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, click_text, aweme_id)
  );

  CREATE TABLE IF NOT EXISTS feishu_bot_default_commands (
    bot_id INTEGER PRIMARY KEY,
    default_command TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS feishu_chat_cron_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id INTEGER NOT NULL,
    chat_id TEXT NOT NULL,
    cron_expr TEXT NOT NULL,
    command_text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT,
    next_run_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_feishu_bots_user_id ON feishu_bots(user_id);
  CREATE INDEX IF NOT EXISTS idx_at_users_record_lookup ON at_users_record(bot_id, at_by, deleted_at, sort_order, created_at);
  CREATE INDEX IF NOT EXISTS idx_douyin_aweme_records_lookup ON douyin_aweme_records(user_id, click_text);
  CREATE INDEX IF NOT EXISTS idx_feishu_chat_cron_tasks_due ON feishu_chat_cron_tasks(enabled, next_run_at);
`);
