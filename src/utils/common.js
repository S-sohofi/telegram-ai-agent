

export function normalizeWebhookUrl(domain) {
  if (!domain) {
    throw new Error('WORKER_DOMAIN is not configured');
  }

  const value = String(domain).trim();
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function clampInteger(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.floor(Number(value) || minimum)));
}

export function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

export function cleanSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function containsPersian(value) {
  return /[\u0600-\u06ff]/u.test(String(value || ''));
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.hash = '';
    for (const name of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|referrer$)/i.test(name)) {
        url.searchParams.delete(name);
      }
    }
    return url.toString();
  } catch (error) {
    return '';
  }
}

export function getUrlHostname(value) {
  try {
    return new URL(String(value)).hostname.replace(/^www\./i, '');
  } catch (error) {
    return '';
  }
}

export function byteLength(value) {
  return new TextEncoder().encode(String(value)).length;
}

export function formatError(error) {
  if (!error) return 'Unknown error';
  return error.stack || error.message || String(error);
}
