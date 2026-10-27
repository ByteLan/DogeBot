export const USERS_COPY_CARD_KIND = 'users_copy';
export type UsersCopyCardAction = 'withdraw' | 'confirm';

export function buildUsersCopyCard(requestId: string, count: number) {
  return {
    schema: '2.0',
    body: {
      elements: [
        { tag: 'markdown', content: `是否将所选用户的全部 **${count}** 位已记录 @ 人员复制到你的 /users 列表？` },
        { tag: 'markdown', content: '将合并到你的现有列表，重复人员自动去重。实际复制以确认时的有效名单为准。仅命令触发人可以操作。' },
        {
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: '8px',
          columns: (['withdraw', 'confirm'] as const).map((action) => ({
            tag: 'column',
            width: 'weighted',
            weight: 1,
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: action === 'withdraw' ? '撤回' : '确认' },
              type: action === 'withdraw' ? 'danger_filled' : 'primary_filled',
              width: 'fill',
              behaviors: [{ type: 'callback', value: { kind: USERS_COPY_CARD_KIND, action, requestId } }]
            }]
          }))
        }
      ]
    }
  };
}

export function buildUsersCopyResultCard(copiedCount: number, addedCount: number) {
  return {
    schema: '2.0',
    body: { elements: [{
      tag: 'markdown',
      content: `已复制 **${copiedCount}** 位 @ 人员到你的 /users 列表，其中新增或恢复 **${addedCount}** 位，已有 **${copiedCount - addedCount}** 位。`
    }] }
  };
}
