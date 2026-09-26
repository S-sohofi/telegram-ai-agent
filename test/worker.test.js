import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';
import { callTextAI } from '../src/services/ai.js';
import { replyToMessageWithSources } from '../src/services/telegram.js';
import {
  extractFinalAnswer,
  extractTextFromAIResponse
} from '../src/utils/ai-response.js';
import {
  isCommand,
  shouldBotRespond,
  stripBotMention
} from '../src/utils/telegram-message.js';

function webhookRequest(body, headers = {}) {
  return new Request('https://worker.test/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('health endpoint reports service status', async () => {
  const response = await worker.fetch(new Request('https://worker.test/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: 'Telegram AI Bot Worker'
  });
});

test('inline webhook processing acknowledges an irrelevant update', async () => {
  const response = await worker.fetch(webhookRequest({ update_id: 1 }), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'OK');
});

test('webhook rejects an invalid secret', async () => {
  const response = await worker.fetch(webhookRequest(
    { update_id: 1 },
    { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }
  ), {
    TELEGRAM_WEBHOOK_SECRET: 'correct'
  });
  assert.equal(response.status, 403);
});

test('webhook setup applies the secret and reports Telegram state', async () => {
  const originalFetch = globalThis.fetch;
  const telegramCalls = [];

  globalThis.fetch = async (url, options) => {
    const method = new URL(String(url)).pathname.split('/').pop();
    telegramCalls.push({ method, payload: JSON.parse(options.body) });
    const result = method === 'getWebhookInfo'
      ? { url: 'https://worker.test/', pending_update_count: 0 }
      : true;
    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = await worker.fetch(
      new Request('https://worker.test/setWebhook'),
      {
        TELEGRAM_BOT_TOKEN: 'test-token',
        TELEGRAM_WEBHOOK_SECRET: 'test-secret'
      }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.webhook.pending_update_count, 0);
    assert.equal(telegramCalls[0].method, 'setWebhook');
    assert.equal(telegramCalls[0].payload.url, 'https://worker.test');
    assert.equal(telegramCalls[0].payload.secret_token, 'test-secret');
    assert.equal(telegramCalls[1].method, 'getWebhookInfo');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue binding receives the Telegram update before acknowledgement', async () => {
  let queued = null;
  const response = await worker.fetch(webhookRequest({ update_id: 123 }), {
    TELEGRAM_UPDATES: {
      async send(value) {
        queued = value;
      }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(queued.update_id, 123);
});

test('queued private messages send typing from the webhook immediately', async () => {
  const originalFetch = globalThis.fetch;
  const telegramMethods = [];
  let queued = null;

  globalThis.fetch = async (url) => {
    telegramMethods.push(new URL(String(url)).pathname.split('/').pop());
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = await worker.fetch(webhookRequest({
      update_id: 124,
      message: {
        message_id: 10,
        chat: { id: 7, type: 'private' },
        from: { id: 8, username: 'tester' },
        text: 'Hello'
      }
    }), {
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_UPDATES: {
        async send(value) {
          queued = value;
        }
      }
    });

    assert.equal(response.status, 200);
    assert.equal(queued.update_id, 124);
    assert.deepEqual(telegramMethods, ['sendChatAction']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('queue consumer acknowledges success and retries unexpected failures', async () => {
  let acknowledged = false;
  let retried = false;
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    await worker.queue({
      messages: [
        {
          body: {},
          ack() {
            acknowledged = true;
          },
          retry() {
            throw new Error('Success should not retry');
          }
        },
        {
          body: null,
          ack() {
            throw new Error('Failure should not acknowledge');
          },
          retry() {
            retried = true;
          }
        }
      ]
    }, {});
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(acknowledged, true);
  assert.equal(retried, true);
});

test('Telegram command and mention helpers preserve group behavior', () => {
  const env = { BOT_USERNAME: '@MyAgent', BOT_ID: '42' };
  assert.equal(isCommand('/check@MyAgent claim', 'check', env), true);
  assert.equal(stripBotMention('hello @MyAgent', 'MyAgent'), 'hello');
  assert.equal(shouldBotRespond({ chat: { type: 'private' } }, env), true);
  assert.equal(shouldBotRespond({
    chat: { type: 'group' },
    text: 'hello @MyAgent'
  }, env), true);
});

test('Workers AI response extraction removes hidden reasoning', () => {
  const response = { result: { response: '<think>secret</think>Visible answer' } };
  const text = extractTextFromAIResponse(response);
  assert.equal(extractFinalAnswer(text), 'Visible answer');
});

test('Gemini is primary and exposes native Google Search grounding', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /gemini-2\.5-flash:generateContent$/);
    assert.equal(options.headers['x-goog-api-key'], 'test-gemini-key');
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'Fresh answer' }] },
        groundingMetadata: {
          webSearchQueries: ['fresh query'],
          groundingChunks: [{
            web: { title: 'Official source', uri: 'https://example.com/current' }
          }]
        }
      }]
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await callTextAI([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'What happened today?' }
    ], { GEMINI_API_KEY: 'test-gemini-key' });

    assert.equal(result.__selectedProvider, 'gemini');
    assert.equal(result.__selectedModel, 'gemini-2.5-flash');
    assert.deepEqual(result.__usedTools, ['google_search']);
    assert.equal(result.response, 'Fresh answer');
    assert.deepEqual(result.__groundingSources, [{
      title: 'Official source',
      url: 'https://example.com/current'
    }]);
    assert.ok(requestBody.tools[0].google_search);
    assert.match(requestBody.system_instruction.parts[0].text, /Trusted runtime clock/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('search sources are sent as clickable titles without visible URLs', async () => {
  const originalFetch = globalThis.fetch;
  const payloads = [];

  globalThis.fetch = async (url, options) => {
    payloads.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await replyToMessageWithSources({
      message_id: 22,
      chat: { id: 7, type: 'private' }
    }, 'Fresh answer', [{
      id: 'S1',
      title: 'Example News',
      url: 'https://example.com/a/very/long/search/result?with=query'
    }], {
      TELEGRAM_BOT_TOKEN: 'test-token'
    });

    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].text, 'Fresh answer');
    assert.equal(payloads[1].text, 'Sources:\n[S1] Example News');
    assert.doesNotMatch(payloads[1].text, /https?:\/\//);
    assert.deepEqual(payloads[1].entities, [{
      type: 'text_link',
      offset: 14,
      length: 12,
      url: 'https://example.com/a/very/long/search/result?with=query'
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini rate limits advance to the next configured Gemini model', async () => {
  const originalFetch = globalThis.fetch;
  const requestedModels = [];

  globalThis.fetch = async (url) => {
    const model = decodeURIComponent(String(url).match(/models\/([^:]+):/)[1]);
    requestedModels.push(model);
    if (requestedModels.length === 1) {
      return new Response(JSON.stringify({
        error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limit exceeded' }
      }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'Fallback answer' }] } }]
    }), { headers: { 'content-type': 'application/json' } });
  };

  try {
    const result = await callTextAI([
      { role: 'user', content: 'Hello' }
    ], {
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_MODELS: 'gemini-2.5-flash,gemini-3.8-flash'
    });

    assert.deepEqual(requestedModels, ['gemini-2.5-flash', 'gemini-3.8-flash']);
    assert.equal(result.__selectedModel, 'gemini-3.8-flash');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Gemini authentication failures fall back to Workers AI', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { status: 'PERMISSION_DENIED', message: 'API key not valid' }
  }), { status: 403, headers: { 'content-type': 'application/json' } });

  try {
    const result = await callTextAI([
      { role: 'user', content: 'Hello' }
    ], {
      GEMINI_API_KEY: 'invalid-key',
      AI: {
        async run() {
          return { response: 'Cloudflare fallback' };
        }
      }
    });

    assert.equal(result.__selectedModel, '@cf/zai-org/glm-4.7-flash');
    assert.equal(extractTextFromAIResponse(result), 'Cloudflare fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private text messages use Workers AI and send a Telegram reply', async () => {
  const originalFetch = globalThis.fetch;
  const telegramMethods = [];
  const history = new Map();

  globalThis.fetch = async (url) => {
    const method = new URL(String(url)).pathname.split('/').pop();
    telegramMethods.push(method);
    return new Response(JSON.stringify({ ok: true, result: true }), {
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const response = await worker.fetch(webhookRequest({
      update_id: 55,
      message: {
        message_id: 9,
        chat: { id: 7, type: 'private' },
        from: { id: 8, username: 'tester' },
        text: 'Hello'
      }
    }), {
      BOT_ID: '42',
      BOT_USERNAME: 'MyAgent',
      TELEGRAM_BOT_TOKEN: 'test-token',
      AI: {
        async run() {
          return { response: 'Hello back' };
        }
      },
      CHAT_HISTORY: {
        async get(key) {
          return history.get(key) || null;
        },
        async put(key, value) {
          history.set(key, value);
        }
      }
    });

    assert.equal(response.status, 200);
    assert.ok(telegramMethods.includes('sendChatAction'));
    assert.ok(telegramMethods.includes('sendMessage'));
    const storedMessages = JSON.parse(history.get('chat:7:history'));
    assert.equal(storedMessages.at(-1).text, 'Hello back');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
