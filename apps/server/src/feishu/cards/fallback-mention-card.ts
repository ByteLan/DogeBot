import type { FeishuBot } from '../../types.js';
import { replyCard } from '../api.js';

export const FALLBACK_MENTION_CARD_KIND = 'fallback_mention_candidates';
export const FALLBACK_MENTION_FORM_FIELD = 'fallback_mention_user_ids';

export type FallbackMentionCardAction = 'withdraw' | 'add_all' | 'add';

export type FallbackMentionCandidate = {
  id: string;
  name: string;
};

type FallbackMentionCardContext = {
  sourceMessageId: string;
  atById: string;
  atByName: string;
};

function plainText(content: string) {
  return { tag: 'plain_text', content };
}

function candidateLabel(candidate: FallbackMentionCandidate) {
  const name = candidate.name.trim() || candidate.id;
  return name === candidate.id ? candidate.id : `${name}（${candidate.id}）`;
}

function actionLabel(action: FallbackMentionCardAction) {
  if (action === 'withdraw') return '撤回';
  if (action === 'add_all') return '加入列表并展示所有';
  return '加入列表并展示';
}

function actionButton(action: FallbackMentionCardAction, context: FallbackMentionCardContext) {
  return {
    tag: 'button',
    name: `fallback_mention_${action}`,
    text: plainText(actionLabel(action)),
    type: action === 'withdraw' ? 'danger_filled' : action === 'add' ? 'primary_filled' : 'default',
    width: 'fill',
    ...(action === 'withdraw' ? {} : { form_action_type: 'submit' }),
    behaviors: [
      {
        type: 'callback',
        value: {
          kind: FALLBACK_MENTION_CARD_KIND,
          action,
          ...context
        }
      }
    ]
  };
}

export function isFallbackMentionCardAction(value: unknown): value is FallbackMentionCardAction {
  return value === 'withdraw' || value === 'add_all' || value === 'add';
}

export function buildFallbackMentionCard(candidates: FallbackMentionCandidate[], context: FallbackMentionCardContext) {
  return {
    schema: '2.0',
    body: {
      elements: [
        {
          tag: 'markdown',
          content: `检测到当前消息及其引用消息中共有 **${candidates.length}** 位被 @ 的用户。请选择要加入人员列表的用户。`
        },
        {
          tag: 'person_list',
          element_id: 'fallback_mention_person_list',
          drop_invalid_user_id: true,
          show_avatar: true,
          size: 'large',
          persons: candidates.map((candidate) => ({ id: candidate.id }))
        },
        { tag: 'hr' },
        {
          tag: 'form',
          element_id: 'fallback_mention_form',
          name: 'fallback_mention_form',
          direction: 'vertical',
          vertical_spacing: '10px',
          elements: [
            {
              tag: 'multi_select_static',
              element_id: FALLBACK_MENTION_FORM_FIELD,
              name: FALLBACK_MENTION_FORM_FIELD,
              type: 'default',
              width: 'fill',
              required: true,
              placeholder: plainText('选择要加入人员列表的用户'),
              selected_values: [],
              options: candidates.map((candidate) => ({
                text: plainText(candidateLabel(candidate)),
                value: candidate.id
              }))
            },
            {
              tag: 'column_set',
              flex_mode: 'none',
              horizontal_spacing: '8px',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [actionButton('withdraw', context)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [actionButton('add_all', context)]
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  elements: [actionButton('add', context)]
                }
              ]
            }
          ]
        }
      ]
    }
  };
}

export async function replyFallbackMentionCard(
  bot: FeishuBot,
  messageId: string,
  candidates: FallbackMentionCandidate[],
  context: FallbackMentionCardContext
) {
  await replyCard(bot, messageId, buildFallbackMentionCard(candidates, context), true);
}
