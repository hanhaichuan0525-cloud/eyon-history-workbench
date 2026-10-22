import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const base = 'https://cdn.jsdelivr.net/gh/hanhaichuan0525-cloud/eyon-history-workbench@main/';
const raw = 'https://raw.githubusercontent.com/hanhaichuan0525-cloud/eyon-history-workbench/main/';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const runtime = 'verified runtime';
const workbench = 'verified workbench';
const manifest = (version = '0.15.1') => ({ channel: 'stable', version, entry: 'dist/index.js',
  workbenchEntry: 'dist/workbench.js', sha256: sha(runtime), workbenchSha256: sha(workbench) });
type Fetch = (url: string, options: RequestInit) => Promise<Response> | Response;

function harness(fetcher: Fetch, initial = new Map<string, string>()) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const timers: Array<{ ms: number; run: () => void; cleared: boolean }> = [];
  const writes: string[] = [];
  const values = new Map(initial);
  const window = { parent: null as unknown, document: {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
  window.parent = window;
  const context = vm.createContext({ window, URL, Response, AbortController, TextDecoder, Uint8Array,
    crypto: webcrypto, console: { warn() {}, error() {} },
    CustomEvent: class { constructor(_name: string, _options: unknown) {} },
    setTimeout(run: () => void, ms: number) { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer: { cleared: boolean }) { timer.cleared = true; },
    fetch(url: string, options: RequestInit) { calls.push({ url, options }); return fetcher(url, options); },
    caches: { async open() { return {
      async match(key: string) { return values.has(key) ? new Response(values.get(key)) : undefined; },
      async put(key: string, response: Response) { writes.push(key); values.set(key, await response.text()); },
      async keys() { return [...values.keys()]; },
      async delete(key: string) { return values.delete(key); },
    }; } },
  });
  const source = readFileSync(new URL('../loaders/auto-loader.js', import.meta.url), 'utf8');
  const trigger = '  void load().catch(() => {});\n})();';
  assert.equal(source.split(trigger).length, 2, 'only disable startup; test actual maintained download/cache functions');
  vm.runInContext(source.replace(trigger,
    '  globalThis.loaderProbe = { fetchBytes, fallbackUrl, readBundle, loadVerifiedArtifacts };\n})();'), context);
  const api = context.loaderProbe as {
    fetchBytes(url: string, timeout?: number): Promise<Uint8Array>;
    fallbackUrl(url: string): string | null;
    readBundle(url: string, hash: string, version: string, preferNetwork: boolean): Promise<Uint8Array>;
    loadVerifiedArtifacts(): Promise<{ manifest: ReturnType<typeof manifest>; source: string; runtimeBytes: Uint8Array; workbenchBytes: Uint8Array }>;
  };
  return { api, calls, timers, writes, values };
}

test('CDN 403转同仓库raw，字节通过SHA校验后才接受，120秒覆盖整次代码下载', async () => {
  const h = harness(url => url.startsWith(base) ? new Response('50 MB limit', { status: 403 }) : new Response(workbench));
  const bytes = await h.api.readBundle(base + 'dist/workbench.js?eyon_v=0.15.1', sha(workbench), '0.15.1', true);
  assert.equal(new TextDecoder().decode(bytes), workbench);
  assert.deepEqual(h.calls.map(call => call.url), [base + 'dist/workbench.js?eyon_v=0.15.1', raw + 'dist/workbench.js?eyon_v=0.15.1']);
  assert.ok(h.calls.every(call => call.options.credentials === 'omit' && call.options.cache === 'no-store'));
  assert.ok(h.timers.every(timer => timer.ms === 120000 && timer.cleared));
  assert.equal(h.writes.length, 0);
});

test('主来源200但哈希错误仍尝试备用，双源错误不被当作成功', async () => {
  const valid = harness(url => new Response(url.startsWith(base) ? 'wrong body' : workbench));
  assert.equal(new TextDecoder().decode(await valid.api.readBundle(base + 'dist/workbench.js', sha(workbench), '0.15.1', true)), workbench);
  const invalid = harness(() => new Response('wrong body'));
  await assert.rejects(invalid.api.readBundle(base + 'dist/workbench.js', sha(workbench), '0.15.1', true), /校验失败/u);
  assert.equal(invalid.calls.length, 2);
  assert.equal(invalid.writes.length, 0);
});

test('清单损坏也切备用；完整两份代码通过后最后提交清单，保留旧缓存协议', async () => {
  const h = harness(url => {
    if (url.includes('manifest.json')) return new Response(url.startsWith(base) ? 'invalid json' : JSON.stringify(manifest()));
    return new Response(url.includes('dist/index.js') ? runtime : workbench);
  });
  const result = await h.api.loadVerifiedArtifacts();
  assert.equal(result.manifest.version, '0.15.1');
  assert.equal(result.source, 'network');
  assert.equal(h.writes.at(-1), base + 'manifest.json');
  assert.equal(h.writes.length, 3);
  assert.ok(h.timers.some(timer => timer.ms === 30000));
  assert.ok(h.timers.some(timer => timer.ms === 120000));
  assert.ok(h.calls.some(call => call.url.startsWith(raw + 'manifest.json?eyon_loader=0.3.4&t=')));
});

test('新版界面双源失败时拒绝降级到低于最低兼容版本的旧缓存', async () => {
  const initial = new Map([[base + 'manifest.json', JSON.stringify(manifest('0.15.0'))],
    [base + 'dist/index.js?eyon_v=0.15.0', runtime], [base + 'dist/workbench.js?eyon_v=0.15.0', workbench]]);
  const h = harness(url => {
    if (url.includes('manifest.json')) return new Response(JSON.stringify(manifest()));
    return url.includes('dist/index.js') ? new Response(runtime) : new Response('broken', { status: 503 });
  }, initial);
  await assert.rejects(h.api.loadVerifiedArtifacts(), /低于最低兼容版本|所有清单来源/u);
  assert.equal(h.writes.length, 0);
  assert.deepEqual([...h.values], [...initial]);
});

test('主下载超时会中止请求、清理定时器并切备用，不遗留挂起请求', async () => {
  let h!: ReturnType<typeof harness>;
  h = harness((url, options) => {
    if (url.startsWith(raw)) return new Response(workbench);
    return new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      queueMicrotask(() => h.timers[0].run());
    });
  });
  assert.equal(new TextDecoder().decode(await h.api.readBundle(base + 'dist/workbench.js', sha(workbench), '0.15.1', true)), workbench);
  assert.equal(h.calls[0].options.signal!.aborted, true);
  assert.ok(h.timers.every(timer => timer.cleared));
});

test('备用仅映射固定仓库路径，不将其他站点或其他仓库映射为受信备用', () => {
  const h = harness(() => new Response('unused'));
  assert.equal(h.api.fallbackUrl('https://example.com/file.js'), null);
  assert.equal(h.api.fallbackUrl('https://cdn.jsdelivr.net/gh/other/project@main/file.js'), null);
});
