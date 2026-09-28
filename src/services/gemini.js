import {
  DEFAULT_GEMINI_MODELS,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DEFAULT_TEXT_MAX_TOKENS
} from '../config.js';
import {
  cleanSingleLine,
  numberFromEnv
} from '../utils/common.js';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function callGeminiText(messages, env, options = {}) {
  const apiKeys = getGeminiApiKeys(env);
  if (!apiKeys.length) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const models = getGeminiModels(env);
  const tools = buildGeminiTools(messages, env, options);
  const maxTokens = options.maxTokens
    || numberFromEnv(env.TEXT_MAX_TOKENS, DEFAULT_TEXT_MAX_TOKENS);
  let lastError = null;

  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex += 1) {
    const apiKey = apiKeys[keyIndex];
    const keyLabel = `API key #${keyIndex + 1} (${keyFingerprint(apiKey)})`;
    let rotateKey = false;

    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      const model = models[modelIndex];

      try {
        const response = await requestGemini(model, messages, tools, maxTokens, env, apiKey);
        const result = normalizeGeminiResponse(response, model, tools);
        if (modelIndex > 0 || keyIndex > 0) {
          console.warn(`Gemini fallback selected: ${model} (${keyLabel})`);
        }
        console.log(
          `Gemini response selected: ${model} (${keyLabel})`
          + `${result.__usedTools.length ? ` (tools: ${result.__usedTools.join(', ')})` : ''}`
        );
        return result;
      } catch (error) {
        lastError = error;

        if (tools.length && shouldRetryWithoutTools(error)) {
          try {
            const reason = isRateLimitError(error)
              ? 'tool-enabled request was rate limited'
              : 'tools are unavailable';
            console.warn(`Gemini ${reason} for ${model}; retrying the same model without tools`);
            const response = await requestGemini(model, messages, [], maxTokens, env, apiKey);
            const result = normalizeGeminiResponse(response, model, []);
            result.__toolsDisabledForModel = true;
            console.log(`Gemini response selected: ${model} (${keyLabel}) (tools disabled)`);
            return result;
          } catch (retryError) {
            lastError = retryError;
          }
        }

        console.warn(
          `Gemini model attempt failed (${keyLabel}, ${model}): ${formatGeminiError(lastError)}`
        );

        if (isAuthenticationError(lastError)) {
          rotateKey = true;
          break;
        }
        if (isRateLimitError(lastError)) {
          rotateKey = true;
        }
      }
    }

    if (rotateKey && keyIndex < apiKeys.length - 1) {
      console.warn(
        `Gemini ${keyLabel} is ${isAuthenticationError(lastError) ? 'invalid' : 'rate limited'}; switching to next API key (${keyFingerprint(apiKeys[keyIndex + 1])})`
      );
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

async function requestGemini(model, messages, tools, maxTokens, env, apiKey) {
  const baseUrl = String(env.GEMINI_API_BASE || GEMINI_API_BASE).replace(/\/+$/, '');
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = numberFromEnv(env.GEMINI_TIMEOUT_MS, DEFAULT_GEMINI_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(buildGeminiRequest(messages, tools, maxTokens)),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeoutError = new Error(`Gemini request timed out after ${timeoutMs}ms`);
      timeoutError.code = 'GEMINI_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    const detail = data.error && (data.error.message || data.error.status)
      || response.statusText
      || 'Unknown error';
    const requestError = new Error(
      `Gemini request failed (${response.status}, ${model}): ${String(detail).slice(0, 500)}`
    );
    requestError.status = response.status;
    requestError.apiStatus = data.error && data.error.status;
    throw requestError;
  }

  return data;
}

function buildGeminiRequest(messages, tools, maxTokens) {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(message.content || '') }]
    }));
  const request = {
    system_instruction: {
      parts: [{ text: [systemText, runtimeClockContext()].filter(Boolean).join('\n\n') }]
    },
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.7,
      topP: 0.95
    }
  };

  if (tools.length) request.tools = tools;
  return request;
}

function buildGeminiTools(messages, env, options) {
  if (options.tools === false || env.GEMINI_TOOLS === 'false') return [];

  const prompt = messages
    .filter((message) => message.role !== 'system')
    .map((message) => String(message.content || ''))
    .join('\n');

  if (env.GEMINI_CODE_EXECUTION !== 'false' && isCodeExecutionRequest(prompt)) {
    return [{ code_execution: {} }];
  }

  const tools = [];
  if (env.GEMINI_GOOGLE_SEARCH !== 'false') {
    tools.push({ google_search: {} });
  }
  if (env.GEMINI_URL_CONTEXT !== 'false' && /https?:\/\/\S+/i.test(prompt)) {
    tools.push({ url_context: {} });
  }
  return tools;
}

function isCodeExecutionRequest(prompt) {
  return /\b(calculate|compute|execute|run code|python|plot|chart|solve (?:this )?equation)\b|محاسبه|حساب کن|کد اجرا|پایتون|نمودار/iu
    .test(String(prompt || ''));
}

function runtimeClockContext() {
  const now = new Date();
  const tehran = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short'
  }).format(now);

  return `Trusted runtime clock:\n- UTC: ${now.toISOString()}\n- Tehran: ${tehran}\nUse this clock for current date/time questions.`;
}

function normalizeGeminiResponse(response, model, requestedTools) {
  const candidate = response && Array.isArray(response.candidates)
    ? response.candidates[0]
    : null;
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  const text = parts
    .map((part) => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) {
    const finishReason = candidate && candidate.finishReason;
    throw new Error(`Gemini returned no usable text${finishReason ? ` (${finishReason})` : ''}`);
  }

  const grounding = candidate.groundingMetadata || response.groundingMetadata || null;
  const sources = extractGroundingSources(grounding);
  const usedTools = detectUsedTools(candidate, grounding, requestedTools);

  return {
    __selectedProvider: 'gemini',
    __selectedModel: model,
    __usedTools: usedTools,
    __groundingSources: sources,
    response: text,
    result: response
  };
}

function detectUsedTools(candidate, grounding, requestedTools) {
  const used = [];
  if (grounding && (
    (Array.isArray(grounding.webSearchQueries) && grounding.webSearchQueries.length)
    || (Array.isArray(grounding.groundingChunks) && grounding.groundingChunks.length)
  )) {
    used.push('google_search');
  }
  const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
    ? candidate.content.parts
    : [];
  if (parts.some((part) => part.executableCode || part.codeExecutionResult)) {
    used.push('code_execution');
  }
  if (requestedTools.some((tool) => tool.url_context) && candidate.urlContextMetadata) {
    used.push('url_context');
  }
  return used;
}

function extractGroundingSources(grounding) {
  const chunks = grounding && Array.isArray(grounding.groundingChunks)
    ? grounding.groundingChunks
    : [];
  const seen = new Set();
  const sources = [];

  for (const chunk of chunks) {
    const web = chunk && chunk.web;
    const url = web && String(web.uri || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      title: cleanSingleLine(web.title || new URL(url).hostname),
      url
    });
    if (sources.length >= 5) break;
  }
  return sources;
}

function getGeminiModels(env) {
  const configured = env.GEMINI_MODELS
    ? String(env.GEMINI_MODELS).split(',')
    : DEFAULT_GEMINI_MODELS;
  return [...new Set(configured.map((model) => String(model).trim()).filter(Boolean))];
}

function getGeminiApiKeys(env) {
  const configured = [
    env.GEMINI_API_KEY,
    ...(env.GEMINI_API_KEYS ? String(env.GEMINI_API_KEYS).split(',') : []),
    env.GEMINI_FALLBACK_API_KEY
  ];
  return [...new Set(configured.map((key) => String(key || '').trim()).filter(Boolean))];
}

function keyFingerprint(key) {
  const value = String(key || '');
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : `${value.length}-char key`;
}

function isRateLimitError(error) {
  if (!error) return false;
  return error.status === 429
    || error.apiStatus === 'RESOURCE_EXHAUSTED'
    || /RESOURCE_EXHAUSTED|rate ?limit|quota|too many requests/i.test(error.message || '');
}

function isToolConfigurationError(error) {
  return error && error.status === 400
    && /tool|google.?search|url.?context|code.?execution|not supported/i.test(error.message || '');
}

function shouldRetryWithoutTools(error) {
  // Grounding and other Gemini tools have limits separate from ordinary
  // generateContent calls. A tool-enabled request can therefore return 429
  // while the same key and model still work for a plain request.
  return isToolConfigurationError(error) || isRateLimitError(error);
}

function isAuthenticationError(error) {
  return error && (error.status === 401 || error.status === 403)
    || error && /API_KEY_INVALID|API key not valid/i.test(error.message || '');
}

function formatGeminiError(error) {
  return error && error.message || String(error || 'Unknown error');
}
