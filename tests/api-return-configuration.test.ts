import assert from 'node:assert/strict';
import test from 'node:test';
import { requireCustomApiBaseUrl } from '../src/runtime/customApiCredentials.ts';
import { ScriptWorkbenchSettings } from '../src/runtime/workbenchSettings.ts';
import { requestCustomChatCompletion } from '../src/runtime/tavernRuntimeAdapter.ts';

test('空地址提前给出模块与保存位置，不把密钥或其他模块作为替代', () => {
  for (const value of ['', '  ', '/chat/completions']) {
    assert.throws(() => requireCustomApiBaseUrl(value, '蝴蝶效应结算'), /蝴蝶效应结算.*实际读取.*地址为空.*保存当前模块/u);
  }
  assert.equal(requireCustomApiBaseUrl(' https://relay.example/v1/chat/completions/ '), 'https://relay.example/v1');
});

test('配置保存不接受空地址；保存、重读与下一次生成使用同一模块，不改其他设置', async () => {
  let variables: Record<string, unknown> = { unrelated: { value: 7 } };
  const store = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables, replaceScriptVariables: next => { variables = next; },
  });
  const valid = { apiurl: 'https://relay.example/v1', key: 'fixture-key', model: 'fixture-model', source: 'openai', maxTokens: 8192, temperature: 0.8 };
  store.setGeneration('ruin', valid);
  const before = structuredClone(variables);
  assert.throws(() => store.setGeneration('butterfly', { ...valid, apiurl: ' ' }), /地址为空/u);
  assert.throws(() => store.applyGenerationToAll({ ...valid, apiurl: '' }), /地址为空/u);
  assert.deepEqual(variables, before, '失败不覆盖已保存配置');
  store.setGeneration('butterfly', valid);
  assert.deepEqual(await store.get('butterfly'), store.read().generation.butterfly);
  assert.equal(requireCustomApiBaseUrl((await store.get('butterfly')).apiurl, '蝴蝶效应结算'), valid.apiurl);
  assert.equal(store.read().generation.biography.apiurl, '', '未配置模块仍可读取，不自动继承');
  assert.deepEqual(variables.unrelated, { value: 7 });
});

test('传输端空地址不给宿主或网络发请求，错误不暴露密钥', async () => {
  let fetched = 0;
  const error = await requestCustomChatCompletion({ fetch: async () => { fetched++; return new Response(''); } }, {
    messages: [{ role: 'user', content: '完整正文' }],
    custom_api: { apiurl: '', key: 'private-fixture-key' },
  }).catch(reason => reason);
  assert.ok(error instanceof Error);
  assert.match(error.message, /实际读取.*地址为空.*设置.*API调用/u);
  assert.ok(!error.message.includes('private-fixture-key'));
  assert.equal(fetched, 0);
});
