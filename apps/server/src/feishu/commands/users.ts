import type { FeishuBot, AtRecord } from '../../types.js';
import { db } from '../../db.js';
import { feishuSdkClient } from '../client.js';

const USERS_CARD_PERSON_LIST_CHUNK_SIZE = 100;
const CARD_REFERENCE_READY_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function softDeleteMentions(botId: number, atBy: string, atWhos: string[]) {
  if (atWhos.length === 0) {
    db.prepare(`
      UPDATE at_users_record
      SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE bot_id = ? AND at_by = ? AND deleted_at IS NULL
    `).run(botId, atBy);
    return;
  }

  const stmt = db.prepare(`
    UPDATE at_users_record
    SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE bot_id = ? AND at_by = ? AND at_who = ? AND deleted_at IS NULL
  `);
  const tx = db.transaction((ids: string[]) => ids.forEach((id) => stmt.run(botId, atBy, id)));
  tx(atWhos);
}

export function upsertMentions(botId: number, atBy: string, atByName: string, mentions: Array<{ id: string; name: string }>) {
  if (mentions.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO at_users_record (bot_id, at_by, at_by_name, at_who, at_who_name)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bot_id, at_by, at_who) DO UPDATE SET
      at_by_name = excluded.at_by_name,
      at_who_name = excluded.at_who_name,
      deleted_at = NULL,
      created_at = CASE WHEN at_users_record.deleted_at IS NOT NULL THEN CURRENT_TIMESTAMP ELSE at_users_record.created_at END,
      updated_at = CURRENT_TIMESTAMP
  `);
  const tx = db.transaction((items: Array<{ id: string; name: string }>) => items.forEach((item) => stmt.run(botId, atBy, atByName, item.id, item.name)));
  tx(mentions);
}

export function topMentions(botId: number, atBy: string, atWhos: string[]) {
  if (atWhos.length === 0) return;
  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM at_users_record WHERE bot_id = ? AND at_by = ?').get(botId, atBy) as { value: number }).value;
  const stmt = db.prepare(`
    UPDATE at_users_record
    SET sort_order = ?, updated_at = CURRENT_TIMESTAMP
    WHERE bot_id = ? AND at_by = ? AND at_who = ? AND deleted_at IS NULL
  `);
  const tx = db.transaction((ids: string[]) => ids.forEach((id, index) => stmt.run(maxSort + ids.length - index, botId, atBy, id)));
  tx(atWhos);
}

export function listMentions(botId: number, atBy: string, newCount?: number) {
  const orderBy = newCount ? 'created_at DESC, id DESC' : 'sort_order DESC, created_at ASC, id ASC';
  const limit = newCount ? 'LIMIT ?' : '';
  return db.prepare(`
    SELECT at_who, at_who_name
    FROM at_users_record
    WHERE bot_id = ? AND at_by = ? AND deleted_at IS NULL
    ORDER BY ${orderBy}
    ${limit}
  `).all(...(newCount ? [botId, atBy, newCount] : [botId, atBy])) as AtRecord[];
}

function usersPersonListCard(records: AtRecord[]) {
  const firstChunk = records.slice(0, USERS_CARD_PERSON_LIST_CHUNK_SIZE);
  const elements: object[] = firstChunk.length > 0
    ? [usersPersonListElement(firstChunk, 0)]
    : [{ tag: 'markdown', content: '暂无已记录用户', element_id: 'users_empty' }];
  return {
    schema: '2.0',
    body: { elements }
  };
}

function usersMarkdownCard(records: AtRecord[]) {
  const firstChunk = records.slice(0, USERS_CARD_PERSON_LIST_CHUNK_SIZE);
  const elements: object[] = firstChunk.length > 0
    ? [usersMarkdownElement(firstChunk, 0)]
    : [{ tag: 'markdown', content: '暂无已记录用户', element_id: 'users_markdown_empty' }];
  return {
    schema: '2.0',
    body: { elements }
  };
}

function usersMarkdownElement(records: AtRecord[], index: number) {
  return {
    tag: 'markdown',
    element_id: `users_markdown_${index}`,
    content: records.map((record) => `<at id=${record.at_who}></at>`).join(' ')
  };
}

function usersPersonListElement(records: AtRecord[], index: number) {
  return {
    tag: 'person_list',
    element_id: `users_person_list_${index}`,
    drop_invalid_user_id: true,
    show_avatar: true,
    size: 'large',
    persons: records.map((record) => ({ id: record.at_who }))
  };
}

function usersDividerElement(index: number) {
  return {
    tag: 'hr',
    element_id: `users_divider_${index}`
  };
}

function chunkUsersRecords(records: AtRecord[]) {
  const chunks: AtRecord[][] = [];
  for (let index = 0; index < records.length; index += USERS_CARD_PERSON_LIST_CHUNK_SIZE) {
    chunks.push(records.slice(index, index + USERS_CARD_PERSON_LIST_CHUNK_SIZE));
  }
  return chunks;
}

async function createCardEntity(client: Awaited<ReturnType<typeof feishuSdkClient>>, card: object) {
  const createResult = await client.cardkit.v1.card.create({
    data: {
      type: 'card_json',
      data: JSON.stringify(card)
    }
  });
  const cardId = createResult.data?.card_id;
  if (!cardId) throw new Error('failed to create card entity');
  await sleep(CARD_REFERENCE_READY_DELAY_MS);
  return cardId;
}

async function replyCardReference(client: Awaited<ReturnType<typeof feishuSdkClient>>, messageId: string, cardId: string, replyInThread = false) {
  return client.im.v1.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      reply_in_thread: replyInThread
    }
  });
}

async function appendUsersCardElements(client: Awaited<ReturnType<typeof feishuSdkClient>>, cardId: string, chunks: AtRecord[][], buildElements: (chunk: AtRecord[], index: number) => object[]) {
  let sequence = 1;
  for (let index = 1; index < chunks.length; index += 1) {
    await client.cardkit.v1.cardElement.create({
      path: { card_id: cardId },
      data: {
        type: 'append',
        sequence,
        uuid: `users_${cardId}_${sequence}`,
        elements: JSON.stringify(buildElements(chunks[index], index))
      }
    });
    sequence += 1;
  }
}

export async function replyUsersCard(bot: FeishuBot, messageId: string, records: AtRecord[], replyInThread = false) {
  const client = await feishuSdkClient(bot);
  const chunks = chunkUsersRecords(records);

  const personListCardId = await createCardEntity(client, usersPersonListCard(records));
  const personListReply = await replyCardReference(client, messageId, personListCardId, replyInThread);
  await appendUsersCardElements(client, personListCardId, chunks, (chunk, index) => [
    usersDividerElement(index),
    usersPersonListElement(chunk, index)
  ]);

  const personListMessageId = personListReply.data?.message_id;
  if (!personListMessageId) throw new Error('failed to get person list message id');
  const markdownCardId = await createCardEntity(client, usersMarkdownCard(records));
  await replyCardReference(client, personListMessageId, markdownCardId, true);
  await appendUsersCardElements(client, markdownCardId, chunks, (chunk, index) => [usersMarkdownElement(chunk, index)]);
}
