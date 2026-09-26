import {
  DEFAULT_GLM_MAX_TOKENS,
  DEFAULT_GLM_RETRY_MAX_TOKENS,
  DEFAULT_TEXT_MAX_TOKENS,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_WHISPER_MODEL,
  SYSTEM_PROMPT
} from '../config.js';
import {
  extractFinalAnswer,
  extractTextFromAIResponse,
  getAIFinishReason,
  summarizeAIResponseShape
} from '../utils/ai-response.js';
import { formatError, numberFromEnv } from '../utils/common.js';
import { arrayBufferToBase64 } from '../utils/media.js';
import { callGeminiText } from './gemini.js';

export async function generateTextResult(prompt, env) {
  const aiResponse = await callTextAI([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt }
  ], env);

  const sources = Array.isArray(aiResponse.__groundingSources)
    ? aiResponse.__groundingSources
    : [];
  const responseText = removeVisibleSourceUrls(
    extractFinalAnswer(extractTextFromAIResponse(aiResponse) || ''),
    sources
  );
  if (!responseText) {
    throw new Error('Could not parse AI response');
  }

  return { text: responseText, sources };
}

export async function callTextAI(messages, env, options = {}) {
  if (env.GEMINI_API_KEY && env.GEMINI_ENABLED !== 'false') {
    try {
      return await callGeminiText(messages, env, options);
    } catch (error) {
      console.warn('All Gemini attempts failed; switching to Cloudflare Workers AI:', formatError(error));
    }
  }

  return await callCloudflareText(messages, env, options);
}

async function callCloudflareText(messages, env, options = {}) {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding is not configured');
  }

  const models = getTextModels(env);
  let lastError = null;
  const maxTokens = options.maxTokens || numberFromEnv(env.TEXT_MAX_TOKENS, DEFAULT_TEXT_MAX_TOKENS);

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const tokenBudgets = getModelTokenBudgets(model, maxTokens, env);

    for (let attemptIndex = 0; attemptIndex < tokenBudgets.length; attemptIndex += 1) {
      const attempt = attemptIndex + 1;
      const input = {
        messages,
        max_tokens: tokenBudgets[attemptIndex]
      };

      try {
        const response = await env.AI.run(model, input);
        const responseText = extractTextFromAIResponse(response);
        const finalText = extractFinalAnswer(responseText || '');
        const finishReason = getAIFinishReason(response);
        const wasTruncated = finishReason === 'length';

        if (finalText && !wasTruncated) {
          if (modelIndex > 0) {
            console.warn(`Workers AI fallback selected: ${model}`);
          }
          console.log(`Workers AI response selected: ${model} (attempt ${attempt})`);
          return {
            __selectedModel: model,
            __selectedAttempt: attempt,
            result: response
          };
        }

        lastError = new Error(
          wasTruncated
            ? `Workers AI completion reached its token limit (${model})`
            : `Workers AI returned no usable text (${model})`
        );
        console.warn(
          `Workers AI response incomplete (${model}, attempt ${attempt}/${tokenBudgets.length}):`,
          summarizeAIResponseShape(response)
        );
      } catch (error) {
        lastError = error;
        console.warn(
          `Workers AI model attempt failed (${model}, attempt ${attempt}/${tokenBudgets.length}):`,
          formatError(error)
        );
      }
    }

    if (modelIndex < models.length - 1) {
      console.warn(`Workers AI is switching from ${model} to fallback ${models[modelIndex + 1]}`);
    }
  }

  throw lastError || new Error('All Workers AI text models failed');
}

function getModelTokenBudgets(model, requestedMaxTokens, env) {
  if (!String(model).includes('glm-4.7-flash')) {
    return [requestedMaxTokens];
  }

  const firstBudget = Math.max(
    requestedMaxTokens,
    numberFromEnv(env.GLM_MAX_TOKENS, DEFAULT_GLM_MAX_TOKENS)
  );
  const retryBudget = Math.max(
    firstBudget + 1,
    numberFromEnv(env.GLM_RETRY_MAX_TOKENS, DEFAULT_GLM_RETRY_MAX_TOKENS)
  );
  return uniqueNumbers([firstBudget, retryBudget]);
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Math.floor(Number(value))).filter((value) => value > 0))];
}

function getTextModels(env) {
  const configured = [
    env.TEXT_MODEL,
    ...(env.TEXT_FALLBACK_MODELS ? String(env.TEXT_FALLBACK_MODELS).split(',') : [])
  ];
  const defaults = [
    DEFAULT_TEXT_MODEL,
    '@cf/qwen/qwen3-30b-a3b-fp8',
    '@cf/meta/llama-3.1-8b-instruct-fast'
  ];

  return uniqueStrings([...configured, ...defaults]);
}

export function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export async function transcribeAudioWithWorkersAI(audioBuffer, env) {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding is not configured');
  }

  const model = env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL;
  const useBase64Input = model.includes('whisper-large-v3-turbo') || env.WHISPER_INPUT_FORMAT === 'base64';
  const input = useBase64Input
    ? { audio: arrayBufferToBase64(audioBuffer), task: 'transcribe' }
    : { audio: [...new Uint8Array(audioBuffer)] };

  const response = await env.AI.run(model, input);
  const text = extractTranscriptionText(response);
  if (!text) {
    console.error('Unparsed transcription response:', JSON.stringify(response));
    throw new Error('Could not parse transcription response');
  }

  return String(text).trim();
}

function extractTranscriptionText(response) {
  if (!response) return null;
  if (typeof response === 'string') return response;
  if (response.text) return response.text;
  if (response.transcription_info && response.transcription_info.text) return response.transcription_info.text;
  if (response.result && response.result.text) return response.result.text;
  if (response.result && response.result.transcription_info && response.result.transcription_info.text) {
    return response.result.transcription_info.text;
  }
  return extractTextFromAIResponse(response);
}

export async function analyzeImageWithWorkersAI(imageBuffer, mimeType, prompt, env) {
  if (!env.AI) {
    throw new Error('Cloudflare Workers AI binding is not configured');
  }

  const model = env.VISION_MODEL || DEFAULT_VISION_MODEL;
  const imageBase64 = arrayBufferToBase64(imageBuffer);
  const response = await env.AI.run(model, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    image: `data:${mimeType};base64,${imageBase64}`,
    max_tokens: numberFromEnv(env.VISION_MAX_TOKENS, 512)
  });

  const text = extractFinalAnswer(extractTextFromAIResponse(response) || '');
  if (!text) {
    throw new Error('Could not parse vision response');
  }

  return text;
}

function removeVisibleSourceUrls(text, sources) {
  if (!sources.length) return text;

  let cleaned = String(text)
    .replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/gi, '$1');

  for (const source of sources) {
    if (!source || !source.url) continue;
    cleaned = cleaned.split(String(source.url)).join(cleanSingleSourceTitle(source));
  }

  return cleaned
    .replace(/https?:\/\/[^\s)\]}]+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function cleanSingleSourceTitle(source) {
  const title = String(source && source.title || '').replace(/\s+/g, ' ').trim();
  return title || 'Source';
}
