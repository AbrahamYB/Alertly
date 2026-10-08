import test from 'node:test';
import assert from 'node:assert/strict';
import { aiConfig, answerChat, classifyChatScope } from '../lib/ai.js';

test('Groq uses current browser search tools while preserving the question', async () => {
  const messages = [{ role: 'system', content: 'Cite sources.' }, { role: 'user', content: 'Latest Honduras disasters?' }];
  const reply = await answerChat(messages, { config: aiConfig({ AI_API_KEY: 'test-key' }), request: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tools, [{ type: 'browser_search' }]);
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Search succeeded.' } }] }) };
  } });
  assert.equal(reply, 'Search succeeded.');
});

test('Groq search respects explicit opt-out and generic APIs receive no Groq fields', async () => {
  for (const provider of ['groq', 'compatible']) {
    const config = aiConfig({ AI_PROVIDER: provider, AI_BASE_URL: 'https://example.com/v1', AI_MODEL: provider === 'groq' ? 'openai/gpt-oss-20b' : 'buyer-model', AI_API_KEY: 'test-key' });
    for (const content of ['Find current alerts', 'Do not search the web']) {
      const reply = await answerChat([{ role: 'user', content }], { config, request: async (url, options) => {
        assert.equal(String(url), 'https://example.com/v1/chat/completions');
        const body = JSON.parse(options.body);
        if (provider === 'groq') assert.deepEqual(body.tools, content.startsWith('Do not') ? undefined : [{ type: 'browser_search' }]);
        else assert.equal(body.tools, undefined);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'Answer with sources' } }] }) };
      } });
      assert.equal(reply, 'Answer with sources');
    }
  }
});

test('missing keys, exhausted quota and empty answers produce useful errors', async () => {
  await assert.rejects(answerChat([], { config: aiConfig({}) }), /not configured/);
  const config = aiConfig({ AI_API_KEY: 'test-key' });
  await assert.rejects(answerChat([], { config, request: async () => ({ ok: false, status: 429 }) }), /quota/);
  await assert.rejects(answerChat([], { config, request: async () => ({ ok: true, json: async () => ({}) }) }), /empty answer/);
});

test('semantic chat guard classifies intent with context and never enables search', async () => {
  const config = aiConfig({ AI_API_KEY: 'test-key' });
  const usage = [];
  const allowed = await classifyChatScope('What should I do next?', [
    { role: 'user', content: 'There is floodwater at the bridge.' },
    { role: 'assistant', content: 'Avoid the bridge.' },
  ], {
    config,
    onUsage: (entry) => usage.push(entry),
    request: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.tools, undefined);
      assert.equal(body.temperature, 0);
      assert.match(body.messages[0].content, /intent gate for Alertly/);
      assert.match(body.messages[1].content, /floodwater/);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: 'IN_SCOPE' } }], usage: { total_tokens: 42 } }),
      };
    },
  });
  assert.equal(allowed, true);
  assert.equal(usage[0].category, 'chat_guard');
  assert.equal(usage[0].usedSearch, false);
});

test('semantic chat guard rejects unrelated intent and fails closed on unclear output', async () => {
  const config = aiConfig({ AI_API_KEY: 'test-key' });
  const rejected = await classifyChatScope('Who is Verity?', [], {
    config,
    request: async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'OUT_OF_SCOPE' } }] }),
    }),
  });
  assert.equal(rejected, false);

  await assert.rejects(classifyChatScope('Ambiguous request', [], {
    config,
    request: async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ choices: [{ message: { content: 'Maybe' } }] }),
    }),
  }), /invalid decision/);
});
