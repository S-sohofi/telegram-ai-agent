import {
  DEFAULT_TELEGRAM_ACTION_TIMEOUT_MS,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_CHUNK_SIZE
} from '../config.js';
import {
  cleanSingleLine,
  containsPersian,
  formatError,
  jsonResponse,
  normalizeWebhookUrl,
  numberFromEnv
} from '../utils/common.js';
import { fileTooLargeError } from '../utils/media.js';
import {
  getChatId,
  isPrivateChat,
  shouldBotRespond
} from '../utils/telegram-message.js';

let botIdentityPromise = null;

export async function setWebhook(env, requestOrigin = null) {
  const webhookUrl = normalizeWebhookUrl(requestOrigin || env.WORKER_DOMAIN);
  const payload = {
    url: webhookUrl,
    allowed_updates: ['message', 'edited_message']
  };

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  }

  try {
    const result = await telegramApi('setWebhook', payload, env);
    const webhook = await telegramApi('getWebhookInfo', {}, env);
    return jsonResponse({ ok: true, result, webhook });
  } catch (error) {
    console.error('setWebhook error:', formatError(error));
    return jsonResponse({ ok: false, error: error.message }, 500);
  }
}

export async function withTelegramIdentity(env) {
  if (env.BOT_ID && env.BOT_USERNAME) return env;

  if (!botIdentityPromise) {
    botIdentityPromise = telegramApi('getMe', {}, env, {
      timeoutMs: numberFromEnv(
        env.TELEGRAM_ACTION_TIMEOUT_MS,
        DEFAULT_TELEGRAM_ACTION_TIMEOUT_MS
      )
    }).catch((error) => {
      botIdentityPromise = null;
      throw error;
    });
  }

  const identity = await botIdentityPromise;
  return {
    ...env,
    BOT_ID: env.BOT_ID || identity.id,
    BOT_USERNAME: env.BOT_USERNAME || identity.username
  };
}

export async function sendImmediateTypingForUpdate(update, env) {
  const message = update && (update.message || update.edited_message);
  if (!message || !env.TELEGRAM_BOT_TOKEN) return false;

  let shouldRespond = isPrivateChat(message);
  let resolvedEnv = env;

  if (!shouldRespond) {
    try {
      resolvedEnv = await withTelegramIdentity(env);
      const caption = message.caption != null ? message.caption : null;
      shouldRespond = shouldBotRespond(message, resolvedEnv, caption);
    } catch (error) {
      console.error('Could not resolve bot identity for immediate typing:', formatError(error));
      return false;
    }
  }

  if (!shouldRespond) return false;
  return await sendChatAction(getChatId(message), resolvedEnv);
}

async function getTelegramFile(fileId, env) {
  return await telegramApi('getFile', { file_id: fileId }, env);
}

async function downloadTelegramFile(filePath, env, maxBytes) {
  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
  const response = await fetch(fileUrl);

  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength && contentLength > maxBytes) {
    throw fileTooLargeError(contentLength, maxBytes);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    throw fileTooLargeError(buffer.byteLength, maxBytes);
  }

  return buffer;
}

export async function getTelegramFileBytes(fileId, env, maxBytes) {
  const file = await getTelegramFile(fileId, env);
  if (!file || !file.file_path) {
    throw new Error('Telegram getFile returned no file_path');
  }

  if (file.file_size && file.file_size > maxBytes) {
    throw fileTooLargeError(file.file_size, maxBytes);
  }

  const buffer = await downloadTelegramFile(file.file_path, env, maxBytes);
  return { file, buffer };
}

async function telegramApi(method, payload, env, options = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  }

  const telegramUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  let response;

  try {
    response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: controller ? controller.signal : undefined
    });
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { ok: false, description: text || 'Invalid JSON response' };
  }

  if (!response.ok || data.ok === false) {
    throw new Error(`Telegram API ${method} failed: ${data.description || response.status}`);
  }

  return data.result !== undefined ? data.result : data;
}

export async function replyToMessage(message, text, env, parseMode = null) {
  await sendTelegramMessage(getChatId(message), text, env, parseMode, message.message_id);
}

export async function replyToMessageWithSources(message, text, sources, env) {
  await replyToMessage(message, text, env);
  await sendTelegramSourceLinks(
    getChatId(message),
    sources,
    env,
    message.message_id,
    containsPersian(text)
  );
}

async function sendTelegramMessage(chatId, text, env, parseMode = null, replyToMessageId = null) {
  if (!chatId || text == null) return;

  const chunks = splitTelegramMessage(String(text));
  for (const chunk of chunks) {
    const payload = {
      chat_id: chatId,
      text: chunk
    };

    if (replyToMessageId) {
      payload.reply_to_message_id = replyToMessageId;
      payload.allow_sending_without_reply = true;
    }

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    try {
      await telegramApi('sendMessage', payload, env);
    } catch (error) {
      if (parseMode) {
        try {
          const plainPayload = { ...payload };
          delete plainPayload.parse_mode;
          await telegramApi('sendMessage', plainPayload, env);
        } catch (plainError) {
          console.error('Error sending plain Telegram message:', formatError(plainError));
        }
      } else {
        console.error('Error sending Telegram message:', formatError(error));
      }
    }
  }
}

async function sendTelegramSourceLinks(chatId, sources, env, replyToMessageId, isPersian) {
  if (!chatId || !Array.isArray(sources) || !sources.length) return;

  const validSources = sources
    .map((source) => normalizeTelegramSource(source))
    .filter(Boolean)
    .slice(0, 10);
  if (!validSources.length) return;

  let text = `${isPersian ? 'منابع' : 'Sources'}:\n`;
  const entities = [];

  validSources.forEach((source, index) => {
    const prefix = source.id ? `[${source.id}] ` : `${index + 1}. `;
    text += prefix;
    const offset = text.length;
    text += source.title;
    entities.push({
      type: 'text_link',
      offset,
      length: source.title.length,
      url: source.url
    });
    if (index < validSources.length - 1) text += '\n';
  });

  const payload = {
    chat_id: chatId,
    text,
    entities,
    link_preview_options: { is_disabled: true }
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
    payload.allow_sending_without_reply = true;
  }

  try {
    await telegramApi('sendMessage', payload, env);
  } catch (error) {
    console.error('Error sending Telegram source links:', formatError(error));
  }
}

function normalizeTelegramSource(source) {
  if (!source || !source.url) return null;

  let parsed;
  try {
    parsed = new URL(String(source.url));
  } catch (error) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const title = cleanSingleLine(source.title || parsed.hostname.replace(/^www\./i, ''));
  if (!title) return null;
  return {
    id: source.id ? String(source.id) : '',
    title,
    url: parsed.toString()
  };
}

export async function withTyping(chatId, env, operation, action = 'typing') {
  if (!chatId) {
    return await operation();
  }

  let stopped = false;
  let timer = null;
  const sendAndSchedule = async () => {
    await sendChatAction(chatId, env, action);
    if (!stopped) {
      timer = setTimeout(sendAndSchedule, 4000);
    }
  };

  const typingTask = sendAndSchedule();

  try {
    return await operation();
  } finally {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    await typingTask.catch((error) => {
      console.error('Typing loop error:', formatError(error));
    });
  }
}

export async function sendChatAction(chatId, env, action = 'typing') {
  if (!chatId) return false;

  try {
    await telegramApi('sendChatAction', {
      chat_id: chatId,
      action
    }, env, {
      timeoutMs: numberFromEnv(
        env.TELEGRAM_ACTION_TIMEOUT_MS,
        DEFAULT_TELEGRAM_ACTION_TIMEOUT_MS
      )
    });
    return true;
  } catch (error) {
    console.error('Error sending chat action:', formatError(error));
    return false;
  }
}

function splitTelegramMessage(text) {
  if (!text) return [''];
  const chunks = [];
  let rest = text;

  while (rest.length > TELEGRAM_MESSAGE_LIMIT) {
    let cut = rest.lastIndexOf('\n\n', TELEGRAM_SAFE_CHUNK_SIZE);
    if (cut < 500) cut = rest.lastIndexOf('\n', TELEGRAM_SAFE_CHUNK_SIZE);
    if (cut < 500) cut = rest.lastIndexOf(' ', TELEGRAM_SAFE_CHUNK_SIZE);
    if (cut < 500) cut = TELEGRAM_SAFE_CHUNK_SIZE;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);
  return chunks.length ? chunks : [''];
}
