import { handleTelegramUpdate } from './handlers/update.js';
import {
  sendImmediateTypingForUpdate,
  setWebhook
} from './services/telegram.js';
import { formatError, jsonResponse } from './utils/common.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/setWebhook') {
      return await setWebhook(env, url.origin);
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'Telegram AI Bot Worker' });
    }

    if (request.method === 'POST') {
      if (env.TELEGRAM_WEBHOOK_SECRET) {
        const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (secret !== env.TELEGRAM_WEBHOOK_SECRET) {
          return new Response('Forbidden', { status: 403 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch (error) {
        console.error('Invalid update payload:', formatError(error));
        return new Response('Bad Request', { status: 400 });
      }

      if (env.TELEGRAM_UPDATES && typeof env.TELEGRAM_UPDATES.send === 'function') {
        const [enqueueResult] = await Promise.allSettled([
          env.TELEGRAM_UPDATES.send(update),
          sendImmediateTypingForUpdate(update, env)
        ]);

        if (enqueueResult.status === 'rejected') {
          console.error('Could not enqueue Telegram update:', formatError(enqueueResult.reason));
          return new Response('Service Unavailable', { status: 503 });
        }

        return new Response('OK');
      }

      try {
        await handleTelegramUpdate(update, env);
      } catch (error) {
        console.error('Error handling update:', formatError(error));
      }
      return new Response('OK');
    }

    return new Response('Telegram AI Bot is running!');
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        if (await wasUpdateProcessed(message.body, env)) {
          message.ack();
          continue;
        }

        await handleTelegramUpdate(message.body, env);
        await markUpdateProcessed(message.body, env);
        message.ack();
      } catch (error) {
        console.error('Error handling queued Telegram update:', formatError(error));
        message.retry();
      }
    }
  }
};

function updateDeduplicationKey(update) {
  return update && update.update_id != null
    ? `telegram:update:${update.update_id}`
    : null;
}

async function wasUpdateProcessed(update, env) {
  const key = updateDeduplicationKey(update);
  if (!key || !env.CHAT_HISTORY) return false;
  return Boolean(await env.CHAT_HISTORY.get(key));
}

async function markUpdateProcessed(update, env) {
  const key = updateDeduplicationKey(update);
  if (!key || !env.CHAT_HISTORY) return;
  await env.CHAT_HISTORY.put(key, '1', { expirationTtl: 86400 });
}
