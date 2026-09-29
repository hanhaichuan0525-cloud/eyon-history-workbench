import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CustomApiRequestError,
  requestCustomChatCompletion,
} from '../src/runtime/tavernRuntimeAdapter.ts';

test('custom API transport classifies 429 and bounds Retry-After', async () => {
  const error = await requestCustomChatCompletion({
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async () => new Response('{"error":{"message":"busy"}}', {
      status: 429,
      headers: { 'Retry-After': '30' },
    }),
  }, {
    messages: [{ role: 'user', content: 'prompt' }],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: 'deepseek-key',
      model: 'deepseek-chat',
    },
  }).catch(reason => reason);

  assert.ok(error instanceof CustomApiRequestError);
  assert.equal(error.kind, 'provider_http');
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 4_000);
});

test('custom API transport omits optional fields when they are absent', async () => {
  let requestInit: RequestInit | undefined;
  await requestCustomChatCompletion({
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async (_input: string | URL | Request, init?: RequestInit) => {
      requestInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      }), { status: 200 });
    },
  }, {
    messages: [{ role: 'user', content: 'prompt' }],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: 'deepseek-key',
      model: 'deepseek-chat',
    },
  });

  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal('max_tokens' in body, false);
  assert.equal('temperature' in body, false);
  assert.equal('response_format' in body, false);
  assert.equal('custom_include_body' in body, false);
});

test('custom API transport classifies premature stream closure', async () => {
  const error = await requestCustomChatCompletion({
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new Error('Premature close');
      },
    }) as unknown as Response,
  }, {
    messages: [{ role: 'user', content: 'prompt' }],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: 'deepseek-key',
      model: 'deepseek-chat',
    },
  }).catch(reason => reason);

  assert.ok(error instanceof CustomApiRequestError);
  assert.equal(error.kind, 'transport');
  assert.match(error.message, /stream closed prematurely/u);
});
