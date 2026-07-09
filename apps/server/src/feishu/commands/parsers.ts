import type { UsersCommand, DouyinCommand, SetDefaultCommand, RevertCommand, AddCronCommand, PassiveToggleCommand, StyleStickerCommand } from '../../types.js';
import { unquoteCommand, readQuotedToken } from '../../utils/text.js';
import { parseConfigurableRate } from '../../config.js';

export const PASSIVE_TOGGLE_COMMANDS = [
  { command: '/reaction', feature: 'reaction', featureName: '贴表情' },
  { command: '/repeat', feature: 'repeat', featureName: '复读' },
  { command: '/llm-reply', feature: 'llm_reply', featureName: '大模型接话' },
  { command: '/media-repeat', feature: 'media_repeat', featureName: '图片/表情包复读' },
  { command: '/image-reverse', feature: 'image_reverse', featureName: '图片镜像反转' },
  { command: '/sticker-reverse', feature: 'sticker_reverse', featureName: '表情包镜像反转' }
] as const;

export const STYLE_STICKER_COMMANDS = [
  { command: '/byte-style', feature: 'byte_style', featureName: '字节范', flavor: 'bs' },
  { command: '/字节范', feature: 'byte_style', featureName: '字节范', flavor: 'bs' },
  { command: '/scale-new-heights', feature: 'scale_new_heights', featureName: '勇攀高峰', flavor: 'snh' },
  { command: '/勇攀高峰', feature: 'scale_new_heights', featureName: '勇攀高峰', flavor: 'snh' }
] as const;

export function parseUsersCommand(text: string): UsersCommand {
  const commandIndex = text.indexOf('/users');
  if (commandIndex < 0) return { isUsers: false, shouldDelete: false, shouldTop: false };

  const args = text.slice(commandIndex + '/users'.length).trim().split(/\s+/).filter(Boolean);
  const newIndex = args.indexOf('new');
  const parsedNewCount = newIndex >= 0 ? Number(args[newIndex + 1]) : undefined;
  return {
    isUsers: true,
    shouldDelete: args.includes('delete'),
    shouldTop: args.includes('top'),
    newCount: parsedNewCount && parsedNewCount > 0 ? Math.floor(parsedNewCount) : undefined
  };
}

export function parseDouyinCommand(text: string): DouyinCommand {
  const commandIndex = text.indexOf('/douyin');
  if (commandIndex < 0) {
    return {
      isDouyin: false,
      clickText: '',
      count: 1,
      hasCountFlag: false,
      shouldDelete: false,
      shouldSubscribe: false,
      shouldUnsubscribe: false,
      deleteAwemeId: '',
      hasInvalidCount: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  const argsText = text.slice(commandIndex + '/douyin'.length).trim();
  const hasDeleteFlag = /(?:^|\s)--delete(?:\s|$)/.test(argsText);
  const hasSubscribeFlag = /(?:^|\s)--subscribe(?:\s|$)/.test(argsText);
  const hasUnsubscribeFlag = /(?:^|\s)--unsubscribe(?:\s|$)/.test(argsText);
  const actionCount = [hasDeleteFlag, hasSubscribeFlag, hasUnsubscribeFlag].filter(Boolean).length;
  const deleteMatch = argsText.match(/(?:^|\s)--delete\s+(\S+)/);
  const deleteAwemeId = deleteMatch?.[1] || '';
  const hasInvalidDelete = hasDeleteFlag && !/^\d{6,}$/.test(deleteAwemeId);
  const hasCountFlag = /(?:^|\s)--count(?:\s|$)/.test(argsText);
  const countMatch = argsText.match(/(?:^|\s)--count\s+(\S+)/);
  const clickText = argsText
    .replace(/(?:^|\s)--delete(?:\s+\S+)?/, ' ')
    .replace(/(?:^|\s)--subscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--unsubscribe(?:\s|$)/, ' ')
    .replace(/(?:^|\s)--count(?:\s+\S+)?/, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  if (!hasCountFlag) {
    return {
      isDouyin: true,
      clickText: actionCount > 0 ? clickText : argsText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: false,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  if (!countMatch) {
    return {
      isDouyin: true,
      clickText,
      count: 1,
      hasCountFlag,
      shouldDelete: hasDeleteFlag,
      shouldSubscribe: hasSubscribeFlag,
      shouldUnsubscribe: hasUnsubscribeFlag,
      deleteAwemeId,
      hasInvalidCount: true,
      hasInvalidDelete,
      hasConflictingAction: actionCount > 1
    };
  }
  const count = Number(countMatch[1]);
  return {
    isDouyin: true,
    clickText,
    count: Number.isInteger(count) && count > 0 ? count : 1,
    hasCountFlag,
    shouldDelete: hasDeleteFlag,
    shouldSubscribe: hasSubscribeFlag,
    shouldUnsubscribe: hasUnsubscribeFlag,
    deleteAwemeId,
    hasInvalidCount: !Number.isInteger(count) || count <= 0,
    hasInvalidDelete,
    hasConflictingAction: actionCount > 1
  };
}

export function parseSetDefaultCommand(text: string): SetDefaultCommand {
  const commandIndex = text.indexOf('/set-default');
  if (commandIndex < 0) return { isSetDefault: false, defaultCommand: '' };
  return {
    isSetDefault: true,
    defaultCommand: unquoteCommand(text.slice(commandIndex + '/set-default'.length))
  };
}

export function parseRevertCommand(text: string): RevertCommand {
  const matches = ['/revert', '/撤回']
    .map((command) => ({ command, index: text.indexOf(command) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return { isRevert: false, command: '', hasUnknownArgs: false };
  const rest = text.slice(match.index + match.command.length).trim();
  return {
    isRevert: true,
    command: match.command,
    hasUnknownArgs: Boolean(rest)
  };
}

export function isHelpCommand(text: string) {
  return /(?:^|\s)\/help(?:\s|$)/.test(text);
}

export function parseAddCronCommand(text: string): AddCronCommand {
  const commandIndex = text.indexOf('/add-cron');
  if (commandIndex < 0) {
    return {
      isAddCron: false,
      cronExpr: '',
      commandText: '',
      shouldList: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  const rest = text.slice(commandIndex + '/add-cron'.length).trim();
  if (!rest) {
    return {
      isAddCron: true,
      cronExpr: '',
      commandText: '',
      shouldList: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  if (/^--list(?:\s|$)/.test(rest)) {
    const trailing = rest.replace(/^--list(?:\s+|$)/, '').trim();
    return {
      isAddCron: true,
      cronExpr: '',
      commandText: '',
      shouldList: true,
      hasInvalidDelete: false,
      hasConflictingAction: Boolean(trailing)
    };
  }
  if (/^--delete(?:\s|$)/.test(rest)) {
    const next = rest.replace(/^--delete(?:\s+|$)/, '').trim();
    const token = readQuotedToken(next);
    const index = Number(token.token);
    return {
      isAddCron: true,
      cronExpr: '',
      commandText: '',
      shouldList: false,
      deleteIndex: Number.isInteger(index) && index > 0 ? index : undefined,
      hasInvalidDelete: !Number.isInteger(index) || index <= 0,
      hasConflictingAction: Boolean(token.rest)
    };
  }
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const cron = readQuotedToken(rest);
    return {
      isAddCron: true,
      cronExpr: cron.token,
      commandText: unquoteCommand(cron.rest),
      shouldList: false,
      hasInvalidDelete: false,
      hasConflictingAction: false
    };
  }
  const parts = rest.split(/\s+/).filter(Boolean);
  return {
    isAddCron: true,
    cronExpr: parts.slice(0, 5).join(' '),
    commandText: unquoteCommand(parts.slice(5).join(' ')),
    shouldList: false,
    hasInvalidDelete: false,
    hasConflictingAction: false
  };
}

export function parsePassiveToggleCommand(text: string): PassiveToggleCommand {
  const matches = PASSIVE_TOGGLE_COMMANDS
    .map((item) => ({ ...item, index: text.indexOf(item.command) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return { isPassiveToggle: false };

  let rest = text.slice(match.index + match.command.length).trim();
  let shouldEnable = false;
  let shouldDisable = false;
  let rate: number | undefined;
  let hasInvalidRate = false;

  while (rest) {
    if (/^--enable(?:\s|$)/.test(rest)) {
      shouldEnable = true;
      rest = rest.replace(/^--enable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--disable(?:\s|$)/.test(rest)) {
      shouldDisable = true;
      rest = rest.replace(/^--disable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--rate(?:\s|$)/.test(rest)) {
      const next = rest.replace(/^--rate(?:\s+|$)/, '').trim();
      if (!next) {
        hasInvalidRate = true;
        rest = '';
        break;
      }
      const token = readQuotedToken(next);
      const parsedRate = parseConfigurableRate(token.token);
      if (parsedRate === undefined) {
        hasInvalidRate = true;
      } else {
        rate = parsedRate;
      }
      rest = token.rest;
      continue;
    }
    break;
  }

  return {
    isPassiveToggle: true,
    command: match.command,
    feature: match.feature,
    featureName: match.featureName,
    shouldEnable,
    shouldDisable,
    rate,
    hasConflictingAction: shouldEnable && shouldDisable,
    hasInvalidRate,
    hasUnknownArgs: Boolean(rest)
  };
}

export function parseStyleStickerCommand(text: string): StyleStickerCommand {
  const matches = STYLE_STICKER_COMMANDS
    .map((item) => ({ ...item, index: text.indexOf(item.command) }))
    .filter((item) => item.index >= 0)
    .sort((left, right) => left.index - right.index);
  const match = matches[0];
  if (!match) return { isStyleSticker: false };

  let rest = text.slice(match.index + match.command.length).trim();
  let shouldEnable = false;
  let shouldDisable = false;
  let rate: number | undefined;
  let maxChars: number | undefined;
  let hasInvalidRate = false;
  let hasInvalidMax = false;

  while (rest) {
    if (/^--enable(?:\s|$)/.test(rest)) {
      shouldEnable = true;
      rest = rest.replace(/^--enable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--disable(?:\s|$)/.test(rest)) {
      shouldDisable = true;
      rest = rest.replace(/^--disable(?:\s+|$)/, '').trim();
      continue;
    }
    if (/^--rate(?:\s|$)/.test(rest)) {
      const next = rest.replace(/^--rate(?:\s+|$)/, '').trim();
      if (!next) {
        hasInvalidRate = true;
        rest = '';
        break;
      }
      const token = readQuotedToken(next);
      const parsedRate = parseConfigurableRate(token.token);
      if (parsedRate === undefined) {
        hasInvalidRate = true;
      } else {
        rate = parsedRate;
      }
      rest = token.rest;
      continue;
    }
    if (/^--max(?:\s|$)/.test(rest)) {
      const next = rest.replace(/^--max(?:\s+|$)/, '').trim();
      if (!next) {
        hasInvalidMax = true;
        rest = '';
        break;
      }
      const token = readQuotedToken(next);
      const parsed = Number(token.token);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        hasInvalidMax = true;
      } else {
        maxChars = parsed;
      }
      rest = token.rest;
      continue;
    }
    break;
  }

  return {
    isStyleSticker: true,
    command: match.command,
    feature: match.feature,
    featureName: match.featureName,
    flavor: match.flavor,
    shouldEnable,
    shouldDisable,
    rate,
    maxChars,
    hasConflictingAction: shouldEnable && shouldDisable,
    hasInvalidRate,
    hasInvalidMax,
    text: unquoteCommand(rest)
  };
}
