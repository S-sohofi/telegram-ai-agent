import {
  DEFAULT_FACT_CHECK_QUERIES,
  DEFAULT_FACT_CHECK_RESULTS_PER_QUERY,
  ERROR_FACT_CHECK_UNAVAILABLE,
  FACT_CHECK_SYSTEM_PROMPT,
  MAX_FACT_CHECK_SOURCES,
  SYSTEM_PROMPT
} from '../config.js';
import { callTextAI, uniqueStrings } from '../services/ai.js';
import { storeIncomingTextMessage, storeMessage } from '../services/chat-history.js';
import {
  replyToMessage,
  replyToMessageWithSources,
  withTyping
} from '../services/telegram.js';
import { extractFinalAnswer, extractTextFromAIResponse } from '../utils/ai-response.js';
import {
  canonicalizeUrl,
  clampInteger,
  cleanSingleLine,
  containsPersian,
  formatError,
  getUrlHostname,
  numberFromEnv,
  truncateText
} from '../utils/common.js';
import {
  getChatId,
  getCommandArguments,
  normalizedBotUsername
} from '../utils/telegram-message.js';

export async function handleFactCheckCommand(message, env) {
  const { claim, note } = getFactCheckRequest(message, env);
  const languageSample = claim || note || message.text || '';

  if (!claim) {
    const usage = containsPersian(languageSample)
      ? 'یک ادعا بعد از /check بنویس، یا روی پیام حاوی ادعا ریپلای کن و /check بفرست.'
      : 'Add a claim after /check, or reply to a message containing a claim with /check.';
    await replyToMessage(message, usage, env);
    return;
  }

  if (!env.TAVILY_API_KEY) {
    const errorText = containsPersian(languageSample)
      ? 'بررسی آنلاین هنوز تنظیم نشده؛ باید TAVILY_API_KEY را به‌عنوان Secret در Cloudflare Worker اضافه کنی.'
      : 'Online fact checking is not configured. Add TAVILY_API_KEY as a Cloudflare Worker secret.';
    await replyToMessage(message, errorText, env);
    return;
  }

  await withTyping(getChatId(message), env, async () => {
    await storeIncomingTextMessage(message, env, true);
    try {
      const evidence = await collectFactCheckEvidence(claim, note, env);
      const verdict = await generateFactCheckResponse(claim, note, evidence.sources, env);
      const response = appendFactCheckSourceTitles(verdict, evidence.sources, claim);

      await storeMessage(
        getChatId(message),
        normalizedBotUsername(env) || 'Assistant',
        response,
        env,
        true,
        { directedToBot: true }
      );
      await replyToMessageWithSources(message, verdict, evidence.sources, env);
    } catch (error) {
      console.error('Fact-check error:', formatError(error));
      const errorText = containsPersian(languageSample)
        ? ERROR_FACT_CHECK_UNAVAILABLE
        : 'I could not retrieve enough web evidence to check this claim. Please try again later.';
      await replyToMessage(message, errorText, env);
    }
  });
}

function getFactCheckRequest(message, env) {
  const commandText = getCommandArguments(message.text, 'check', env);
  const reply = message.reply_to_message;
  const repliedClaim = reply && (reply.text || reply.caption)
    ? String(reply.text || reply.caption).trim()
    : '';

  if (repliedClaim) {
    return { claim: repliedClaim, note: commandText };
  }

  return { claim: commandText, note: '' };
}

async function collectFactCheckEvidence(claim, note, env) {
  const queries = await buildFactCheckQueries(claim, note, env);
  const searches = await Promise.allSettled(
    queries.map((query) => searchTavily(query, claim, env))
  );

  const results = [];
  for (const search of searches) {
    if (search.status === 'fulfilled') {
      results.push(...search.value);
    } else {
      console.error('Tavily query failed:', formatError(search.reason));
    }
  }

  const sources = deduplicateFactCheckSources(results).slice(0, MAX_FACT_CHECK_SOURCES);
  if (!sources.length) {
    throw new Error('Tavily returned no usable evidence');
  }

  return { queries, sources };
}

async function buildFactCheckQueries(claim, note, env) {
  const maxQueries = clampInteger(
    numberFromEnv(env.FACT_CHECK_MAX_QUERIES, DEFAULT_FACT_CHECK_QUERIES),
    1,
    3
  );
  const fallback = [truncateText(claim, 450)];

  if (maxQueries === 1) {
    return fallback;
  }

  const plannerPrompt = `Create up to ${maxQueries} concise, neutral web-search queries for checking this claim.
Keep one query in the claim's original language. If the claim is not English, make another query in English.
Search for evidence both supporting and contradicting the claim. Do not answer the claim.
Return only a JSON array of strings.

Claim:
${claim}
${note ? `\nUser clarification:\n${note}` : ''}`;

  try {
    const aiResponse = await callTextAI([
      { role: 'system', content: 'You create precise web search queries. Output valid JSON only.' },
      { role: 'user', content: plannerPrompt }
    ], env, { maxTokens: 256, tools: false });
    const responseText = extractFinalAnswer(extractTextFromAIResponse(aiResponse) || '');
    const queries = parseSearchQueries(responseText, maxQueries);
    return queries.length ? queries : fallback;
  } catch (error) {
    console.error('Fact-check query planning failed:', formatError(error));
    return fallback;
  }
}

function parseSearchQueries(text, maxQueries) {
  const jsonMatch = String(text || '').match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return uniqueStrings(parsed)
      .map((query) => truncateText(query, 450))
      .filter((query) => query.length >= 3)
      .slice(0, maxQueries);
  } catch (error) {
    return [];
  }
}

async function searchTavily(query, claim, env) {
  const allowedDepths = new Set(['basic', 'advanced', 'fast', 'ultra-fast']);
  const configuredDepth = String(env.FACT_CHECK_SEARCH_DEPTH || 'basic').toLowerCase();
  const searchDepth = allowedDepths.has(configuredDepth) ? configuredDepth : 'basic';
  const maxResults = clampInteger(
    numberFromEnv(env.FACT_CHECK_RESULTS_PER_QUERY, DEFAULT_FACT_CHECK_RESULTS_PER_QUERY),
    3,
    10
  );
  const body = {
    query,
    search_depth: searchDepth,
    max_results: maxResults,
    topic: inferTavilyTopic(claim),
    include_answer: false,
    include_raw_content: false,
    include_images: false
  };

  if (searchDepth !== 'ultra-fast') {
    body.chunks_per_source = 3;
  }

  if (body.topic === 'general') {
    body.country = String(env.TAVILY_COUNTRY || 'iran').trim().toLowerCase();
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.TAVILY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();
  let data = {};
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    data = {};
  }

  if (!response.ok) {
    const detail = data.detail || data.error || response.statusText || 'Unknown error';
    throw new Error(`Tavily search failed (${response.status}): ${String(detail).slice(0, 300)}`);
  }

  if (!Array.isArray(data.results)) return [];
  return data.results
    .filter((result) => result && result.url && result.content)
    .map((result) => ({
      title: cleanSingleLine(result.title || getUrlHostname(result.url) || 'Source'),
      url: String(result.url),
      content: truncateText(result.content, 1800),
      publishedDate: result.published_date || null,
      score: Number.isFinite(Number(result.score)) ? Number(result.score) : 0
    }));
}

function inferTavilyTopic(claim) {
  const recentPattern = /\b(news|latest|today|yesterday|recent|breaking|current)\b|اخبار|خبر|آخرین|امروز|دیروز|اخیر|جدید/iu;
  return recentPattern.test(String(claim || '')) ? 'news' : 'general';
}

function deduplicateFactCheckSources(results) {
  const byUrl = new Map();

  for (const result of results) {
    const canonicalUrl = canonicalizeUrl(result.url);
    if (!canonicalUrl) continue;
    const existing = byUrl.get(canonicalUrl);
    if (!existing || result.score > existing.score) {
      byUrl.set(canonicalUrl, { ...result, url: canonicalUrl });
    }
  }

  return [...byUrl.values()]
    .sort((a, b) => b.score - a.score)
    .map((source, index) => ({ ...source, id: `S${index + 1}` }));
}

async function generateFactCheckResponse(claim, note, sources, env) {
  const evidenceText = sources.map((source) => {
    const dateLine = source.publishedDate ? `\nPublished: ${source.publishedDate}` : '';
    return `<source id="${source.id}">\nTitle: ${source.title}${dateLine}\nURL host: ${getUrlHostname(source.url)}\nEvidence:\n${source.content}\n</source>`;
  }).join('\n\n');

  const prompt = `Claim to verify:\n${claim}${note ? `\n\nUser clarification:\n${note}` : ''}\n\nUntrusted web evidence:\n${evidenceText}`;
  const aiResponse = await callTextAI([
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n${FACT_CHECK_SYSTEM_PROMPT}` },
    { role: 'user', content: prompt }
  ], env, {
    maxTokens: numberFromEnv(env.FACT_CHECK_MAX_TOKENS, 1000),
    tools: false
  });

  const responseText = extractFinalAnswer(extractTextFromAIResponse(aiResponse) || '');
  if (!responseText) {
    throw new Error('Could not parse fact-check response');
  }
  return sanitizeFactCheckVerdict(responseText, sources);
}

function sanitizeFactCheckVerdict(verdict, sources) {
  const allowedIds = new Set(sources.map((source) => source.id));
  return String(verdict || '')
    .replace(/\[S\d+\]/gi, (citation) => {
      const normalized = citation.slice(1, -1).toUpperCase();
      return allowedIds.has(normalized) ? `[${normalized}]` : '';
    })
    .replace(/https?:\/\/[^\s)\]}]+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function appendFactCheckSourceTitles(verdict, sources, claim) {
  const sourceLines = sources.map((source) =>
    `[${source.id}] ${cleanSingleLine(source.title)}`
  );
  const heading = containsPersian(claim) ? 'منابع' : 'Sources';
  return `${verdict}\n\n${heading}:\n${sourceLines.join('\n')}`;
}
