

export function isPrivateChat(message) {
  return message && message.chat && message.chat.type === 'private';
}

export function getChatId(message) {
  return message && message.chat ? message.chat.id : null;
}

export function getUserDisplayName(message) {
  const from = message && message.from;
  if (!from) return 'User';
  return from.username || from.first_name || from.last_name || 'User';
}

export function normalizedBotUsername(env) {
  return String(env.BOT_USERNAME || '').replace(/^@/, '').trim();
}

export function isCommand(text, command, env) {
  const firstToken = String(text || '').trim().split(/\s+/)[0].toLowerCase();
  const botUsername = normalizedBotUsername(env).toLowerCase();
  const bareCommand = `/${command.toLowerCase()}`;

  return firstToken === bareCommand || (botUsername && firstToken === `${bareCommand}@${botUsername}`);
}

export function getCommandArguments(text, command, env) {
  if (!isCommand(text, command, env)) return '';
  const value = String(text || '').trim();
  const firstWhitespace = value.search(/\s/);
  return firstWhitespace < 0 ? '' : value.slice(firstWhitespace).trim();
}

export function isBotMentioned(message, botUsername, textOverride = null, entitiesOverride = null) {
  if (!botUsername) return false;

  const text = textOverride != null ? textOverride : (message.text || message.caption || '');
  const entities = entitiesOverride != null
    ? entitiesOverride
    : (message.entities || message.caption_entities || []);
  const mention = `@${botUsername}`.toLowerCase();

  if (String(text).toLowerCase().includes(mention)) {
    return true;
  }

  if (Array.isArray(entities)) {
    for (const entity of entities) {
      if (entity.type !== 'mention') continue;
      const value = String(text).slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (value === mention) return true;
    }
  }

  return false;
}

export function isReplyToBot(message, botId) {
  const from = message && message.reply_to_message && message.reply_to_message.from;
  return Boolean(from && botId && String(from.id) === String(botId));
}

export function shouldBotRespond(message, env, caption = null) {
  if (isPrivateChat(message)) {
    return true;
  }

  const botUsername = normalizedBotUsername(env);
  const botId = env.BOT_ID;

  if (caption !== null) {
    return isBotMentioned(message, botUsername, caption, message.caption_entities || []) || isReplyToBot(message, botId);
  }

  return isBotMentioned(message, botUsername) || isReplyToBot(message, botId);
}

export function stripBotMention(text, botUsername) {
  if (!text || !botUsername) return String(text || '');
  const pattern = new RegExp(`@${escapeRegExp(botUsername)}`, 'ig');
  return String(text).replace(pattern, '').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
