export function aiConfig(env = process.env) {
  const provider = env.CHAT_AI_PROVIDER || env.AI_PROVIDER || 'groq';
  return {
    provider,
    baseUrl: (env.CHAT_AI_BASE_URL || env.AI_BASE_URL || (provider === 'groq' ? 'https://api.groq.com/openai/v1' : '')).replace(/\/$/, ''),
    model: env.CHAT_AI_MODEL || env.AI_MODEL || (provider === 'groq' ? 'openai/gpt-oss-20b' : ''),
    key: env.CHAT_AI_API_KEY || env.AI_API_KEY || (provider === 'groq' ? env.GROQ_API_KEY : '') || '',
    search: (env.CHAT_AI_WEB_SEARCH || env.AI_WEB_SEARCH) !== 'false',
  };
}

export async function answerChat(messages, { signal, config = aiConfig(), request = fetch, onUsage } = {}) {
  if (!config.key) throw new Error('AI is not configured yet. Add AI_API_KEY to the server .env file and restart.');
  if (!config.baseUrl || !config.model) throw new Error('Set AI_BASE_URL and AI_MODEL on the server.');
  const url = new URL(config.baseUrl + '/chat/completions');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('AI endpoint must use HTTPS, or HTTP on localhost.');
  const noSearch = /\b(don['’]?t|do not|no|without|skip)\s+(?:web\s+)?(?:search|searching|browse|browsing|internet|web|look)|\bown knowledge\b/i.test(messages.at(-1)?.content || '');
  const body = { model: config.model, messages, stream: false };
  if (config.provider === 'groq') {
    body.max_completion_tokens = 1024;
    body.reasoning_effort = 'low';
    if (config.search && !noSearch) body.tools = [{ type: 'browser_search' }];
  }
  const options = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    body: JSON.stringify(body), signal,
  };
  const response = await request(url, options);
  if (!response.ok) {
    const errors = { 401: 'AI API key was rejected.', 403: 'AI provider denied access to this model.', 413: 'The AI search exceeded the provider’s size limit. Try narrowing the location or date range.', 429: 'AI free quota or rate limit reached. Please try again later.' };
    throw new Error(errors[response.status] || `AI provider is unavailable (HTTP ${response.status}).`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('AI provider returned an empty answer.');
  onUsage?.({
    category: 'chat',
    model: config.model,
    usage: data.usage || {},
    usedSearch: Boolean(body.tools?.length),
    rateLimits: {
      requestLimit: response.headers?.get?.('x-ratelimit-limit-requests') || null,
      requestsRemaining: response.headers?.get?.('x-ratelimit-remaining-requests') || null,
      requestsReset: response.headers?.get?.('x-ratelimit-reset-requests') || null,
      tokenLimit: response.headers?.get?.('x-ratelimit-limit-tokens') || null,
      tokensRemaining: response.headers?.get?.('x-ratelimit-remaining-tokens') || null,
      tokensReset: response.headers?.get?.('x-ratelimit-reset-tokens') || null,
    },
  });
  return text;
}
