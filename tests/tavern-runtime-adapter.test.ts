import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CustomApiRequestError,
  requestCustomChatCompletion,
  resolveHostGlobal,
  resolveTavernHelperFunction,
} from '../src/runtime/tavernRuntimeAdapter.ts';

test('宿主全局可从当前窗口的父/顶层上下文解析', () => {
  const parentMvu = { getMvuData: () => ({}) };
  const local = {
    parent: { Mvu: parentMvu },
    top: { Mvu: { getMvuData: () => ({ stale: true }) } },
  } as unknown as Record<string, unknown>;

  assert.equal(resolveHostGlobal(local, 'Mvu'), parentMvu);
});

test('酒馆助手调用优先绑定活动父窗口，避免读取脚本窗口的旧鉴权', async () => {
  const calls: string[] = [];
  const parentHelper = {
    marker: 'parent',
    async generateRaw(this: { marker: string }) {
      calls.push(this.marker);
      return 'parent-session';
    },
  };
  const localHelper = {
    marker: 'local',
    async generateRaw(this: { marker: string }) {
      calls.push(this.marker);
      return 'stale-session';
    },
  };
  const generateRaw = resolveTavernHelperFunction<() => Promise<string>>({
    TavernHelper: localHelper,
    parent: { TavernHelper: parentHelper },
  }, 'generateRaw');

  assert.ok(generateRaw);
  assert.equal(await generateRaw(), 'parent-session');
  assert.deepEqual(calls, ['parent']);
});

test('独立 API 经酒馆自定义后端发送并保留原始完成响应', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const payload = await requestCustomChatCompletion({
    SillyTavern: {
      getContext: () => ({
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'csrf-token' }),
      }),
    },
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      }), { status: 200 });
    },
  }, {
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'prompt' },
    ],
    custom_api: {
      apiurl: 'https://api.deepseek.com/',
      key: 'deepseek-key',
      model: 'deepseek-chat',
      max_tokens: 2048,
      temperature: 0.6,
      response_format: { type: 'json_object' },
    },
  });

  assert.equal(requestUrl, '/api/backends/chat-completions/generate');
  assert.equal((requestInit?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf-token');
  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.chat_completion_source, 'custom');
  assert.equal(body.reverse_proxy, 'https://api.deepseek.com');
  assert.equal(body.custom_url, 'https://api.deepseek.com');
  assert.equal(body.custom_include_headers, 'Authorization: Bearer deepseek-key');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  // response_format 走顶层字段，不再重复注入 custom_include_body（避免同参数双写冲突）
  assert.equal('custom_include_body' in body, false);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('enable_web_search' in body, false);
  assert.equal('request_images' in body, false);
  assert.deepEqual(payload, {
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
  });
});

test('DeepSeek 一键结构化：强制 json_object、thinking disabled、输出上限 8192', async () => {
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
      max_tokens: 16384,
      temperature: 0.6,
    },
    deepseekStructured: true,
  });

  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.custom_include_body, 'thinking:\n  type: disabled');
  // 官方 DeepSeek 输出硬上限 8192：更大 max_tokens 会被压回。
  assert.equal(body.max_tokens, 8192);
});

test('独立 API 会清理重复 Bearer 前缀与完整补全路径', async () => {
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
      apiurl: 'https://api.deepseek.com/v1/chat/completions',
      key: 'Bearer Bearer deepseek-key',
      model: 'deepseek-chat',
      max_tokens: 1024,
      temperature: 0.5,
    },
  });

  const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
  assert.equal(body.custom_url, 'https://api.deepseek.com/v1');
  assert.equal(body.custom_include_headers, 'Authorization: Bearer deepseek-key');
});

test('独立 API 在空密钥时不发送请求', async () => {
  let called = false;
  await assert.rejects(() => requestCustomChatCompletion({
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  }, {
    messages: [{ role: 'user', content: 'prompt' }],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: '',
      model: 'deepseek-chat',
      max_tokens: 1024,
      temperature: 0.5,
    },
  }), /密钥为空/u);
  assert.equal(called, false);
});

test('独立 API 将 Unauthorized 转换为可操作的鉴权提示', async () => {
  await assert.rejects(() => requestCustomChatCompletion({
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async () => new Response(JSON.stringify({
      error: { message: 'Unauthorized' },
    }), { status: 200 }),
  }, {
    messages: [{ role: 'user', content: 'prompt' }],
    custom_api: {
      apiurl: 'https://api.deepseek.com',
      key: 'deepseek-key',
      model: 'deepseek-chat',
      max_tokens: 1024,
      temperature: 0.5,
    },
  }), /重新填写并保存当前模块的密钥/u);
});

test('上游挂起时按超时中止并抛可重试的 transport 错误', async () => {
  const base = {
    SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
    fetch: async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        // 模拟中转站接受请求后永不返回：只有 abort 才会结束
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }),
  };
  await assert.rejects(
    () => requestCustomChatCompletion(base, {
      messages: [{ role: 'user', content: 'prompt' }],
      custom_api: {
        apiurl: 'https://relay.example.com',
        key: 'relay-key',
        model: 'relay-chat',
        max_tokens: 1024,
        temperature: 0.5,
      },
      timeoutMs: 30,
    }),
    error => error instanceof CustomApiRequestError
      && error.kind === 'transport'
      && /timed out/u.test(error.message),
  );
});

test('中转站返回 <none> 占位错误时归为可重试的 transport 错误', async () => {
  await assert.rejects(
    () => requestCustomChatCompletion({
      SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
      fetch: async () => new Response(JSON.stringify({
        error: { message: '<none>' },
      }), { status: 200 }),
    }, {
      messages: [{ role: 'user', content: 'prompt' }],
      custom_api: {
        apiurl: 'https://relay.example.com',
        key: 'relay-key',
        model: 'relay-chat',
        max_tokens: 1024,
        temperature: 0.5,
      },
    }),
    error => error instanceof CustomApiRequestError
      && error.kind === 'transport'
      && /placeholder error/u.test(error.message),
  );
});

test('中转站返回空错误对象时归为可重试的 transport 错误', async () => {
  await assert.rejects(
    () => requestCustomChatCompletion({
      SillyTavern: { getContext: () => ({ getRequestHeaders: () => ({}) }) },
      fetch: async () => new Response(JSON.stringify({
        error: {},
      }), { status: 200 }),
    }, {
      messages: [{ role: 'user', content: 'prompt' }],
      custom_api: {
        apiurl: 'https://relay.example.com',
        key: 'relay-key',
        model: 'relay-chat',
        max_tokens: 1024,
        temperature: 0.5,
      },
    }),
    error => error instanceof CustomApiRequestError
      && error.kind === 'transport'
      && /placeholder error/u.test(error.message),
  );
});
