import {
  CONTEXT_STOP_WORDS,
  DEFAULT_CONTEXT_BYTES,
  DEFAULT_CONTEXT_MESSAGES,
  DEFAULT_RECENT_CONTEXT_MESSAGES,
  MAX_HISTORY_BYTES,
  MAX_MESSAGES_PER_CHAT
} from '../config.js';
import {
  byteLength,
  clampInteger,
  cleanSingleLine,
  formatError,
  numberFromEnv,
  truncateText
} from '../utils/common.js';
import {
  getChatId,
  getUserDisplayName,
  normalizedBotUsername
} from '../utils/telegram-message.js';

export async function storeIncomingTextMessage(message, env, directedToBot) {
  if (!shouldStoreContextMessage(message, env)) return;

  await storeMessage(
    getChatId(message),
    getUserDisplayName(message),
    message.text,
    env,
    false,
    {
      messageId: message.message_id,
      replyToMessageId: message.reply_to_message && message.reply_to_message.message_id,
      directedToBot: Boolean(directedToBot),
      chatType: message.chat && message.chat.type
    }
  );
}

function shouldStoreContextMessage(message, env) {
  const text = String(message && message.text || '').trim();
  if (!text || (message.from && message.from.is_bot)) return false;

  const firstToken = text.split(/\s+/)[0];
  const addressedCommand = firstToken.match(/^\/[a-z0-9_]+@([a-z0-9_]+)$/i);
  if (addressedCommand) {
    const botUsername = normalizedBotUsername(env).toLowerCase();
    if (botUsername && addressedCommand[1].toLowerCase() !== botUsername) {
      return false;
    }
  }

  return true;
}

export async function storeMessage(chatId, username, text, env, isBot = false, metadata = {}) {
  if (!env.CHAT_HISTORY || text == null) {
    return;
  }

  try {
    const key = historyKey(chatId);
    const history = await getChatHistory(chatId, env);
    const entry = {
      role: isBot ? 'Assistant' : (username || 'User'),
      text: String(text),
      ts: Date.now(),
      ...metadata
    };
    const messageId = metadata.messageId;
    const existingIndex = messageId == null
      ? -1
      : history.findIndex((item) => item && String(item.messageId) === String(messageId));

    if (existingIndex >= 0) {
      history[existingIndex] = entry;
    } else {
      history.push(entry);
    }

    const trimmed = trimHistory(history);
    await env.CHAT_HISTORY.put(key, JSON.stringify(trimmed));
  } catch (error) {
    console.error('Store history error:', formatError(error));
  }
}

async function getChatHistory(chatId, env) {
  if (!env.CHAT_HISTORY) {
    return [];
  }

  try {
    const raw = await env.CHAT_HISTORY.get(historyKey(chatId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Read history error:', formatError(error));
    return [];
  }
}

export async function getChatContext(chatId, env, query = '') {
  const history = await getChatHistory(chatId, env);
  if (!history.length) return '';

  const selected = selectRelevantHistory(history, query, env);
  if (!selected.length) return '';

  const maxBytes = numberFromEnv(env.CONTEXT_MAX_BYTES, DEFAULT_CONTEXT_BYTES);
  const messageLines = [];
  let usedBytes = byteLength('Relevant previous conversation:\n');

  // Keep the newest selected messages if the byte limit is reached.
  for (let i = selected.length - 1; i >= 0; i -= 1) {
    const message = selected[i];
    const line = `${message.role || 'User'}: ${truncateText(message.text, 4000)}`;
    const lineBytes = byteLength(`${line}\n`);
    if (messageLines.length && usedBytes + lineBytes > maxBytes) continue;
    messageLines.unshift(line);
    usedBytes += lineBytes;
  }

  return ['Relevant previous conversation:', ...messageLines].join('\n');
}

function selectRelevantHistory(history, query, env) {
  const candidates = history.filter((message) => message && String(message.text || '').trim());
  if (!candidates.length) return [];

  const maxMessages = clampInteger(
    numberFromEnv(env.CONTEXT_MAX_MESSAGES, DEFAULT_CONTEXT_MESSAGES),
    1,
    MAX_MESSAGES_PER_CHAT
  );
  const recentCount = Math.min(
    maxMessages,
    clampInteger(
      numberFromEnv(env.CONTEXT_RECENT_MESSAGES, DEFAULT_RECENT_CONTEXT_MESSAGES),
      1,
      maxMessages
    )
  );
  const recentStart = Math.max(0, candidates.length - recentCount);
  const selectedIndexes = new Set();

  for (let index = recentStart; index < candidates.length; index += 1) {
    selectedIndexes.add(index);
  }

  const queryTokens = tokenizeForContext(query);
  const remainingSlots = maxMessages - selectedIndexes.size;
  if (remainingSlots > 0 && queryTokens.size) {
    const olderMatches = candidates
      .slice(0, recentStart)
      .map((message, index) => ({
        index,
        score: contextRelevanceScore(message.text, query, queryTokens)
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, remainingSlots);

    for (const match of olderMatches) {
      selectedIndexes.add(match.index);
    }
  }

  return [...selectedIndexes]
    .sort((a, b) => a - b)
    .map((index) => candidates[index]);
}

function tokenizeForContext(text) {
  const tokens = String(text || '').toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  return new Set(tokens.filter((token) => token.length > 1 && !CONTEXT_STOP_WORDS.has(token)));
}

function contextRelevanceScore(messageText, query, queryTokens) {
  const messageTokens = tokenizeForContext(messageText);
  let score = 0;

  for (const token of queryTokens) {
    if (messageTokens.has(token)) {
      score += token.length >= 5 ? 2 : 1;
    }
  }

  const normalizedQuery = cleanSingleLine(query).toLowerCase();
  const normalizedMessage = cleanSingleLine(messageText).toLowerCase();
  if (normalizedQuery.length >= 8 && normalizedMessage.includes(normalizedQuery)) {
    score += 4;
  }

  return score;
}

function trimHistory(history) {
  let trimmed = history.slice(-MAX_MESSAGES_PER_CHAT);
  while (trimmed.length > 1 && byteLength(JSON.stringify(trimmed)) > MAX_HISTORY_BYTES) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function historyKey(chatId) {
  return `chat:${chatId}:history`;
}
