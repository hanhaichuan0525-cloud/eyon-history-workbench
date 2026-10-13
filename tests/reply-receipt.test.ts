import assert from 'node:assert/strict';
import test from 'node:test';
import { createGlobalDataBindings } from '../src/runtime/globalBindings.ts';

// Use the production binding; only the host transport is a fixture. No model calls.
function harness(mode = 'normal') {
  const messages = [{ message_id: 0, role: 'user', message: '我留下笔记。\n\n遣返', is_hidden: false }];
  const calls: string[] = [];
  let chatId = 'chat-A';
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const host = {
    getVariables: () => ({}), getCharWorldbookNames: () => ({ primary: null, additional: [] }),
    getChatWorldbookName: () => null, getGlobalWorldbookNames: () => [], getWorldbook: async () => [],
    getWorldbookNames: () => [], rebindGlobalWorldbooks: async () => {}, createChatMessages: async () => {},
    Mvu: { getMvuData: () => ({}) },
    SillyTavern: { getContext: () => ({ chatId }) },
    getLastMessageId: () => messages.length - 1,
    getChatMessages: (range: number | string) => {
      if (typeof range === 'number') return structuredClone(messages.filter(m => m.message_id === range));
      const [start, end] = range.split('-').map(Number);
      assert.ok(end >= start, 'cannot read a reversed floor range');
      return structuredClone(messages.filter(m => m.message_id >= start && m.message_id <= end));
    },
    triggerSlash: async (command: string) => {
      calls.push(command);
      if (command === '/trigger') return ''; // Native default returns before dispatch.
      assert.equal(command, '/trigger await=true');
      if (mode === 'deferred') await barrier;
      if (mode === 'error') throw new Error('host generation error');
      if (mode === 'chat') chatId = 'chat-B';
      if (mode === 'edit') messages[0].message = '已经改写';
      if (mode === 'new-user') messages.push({ message_id: 1, role: 'user', message: '下一句', is_hidden: false });
      if (mode !== 'silent' && mode !== 'empty') messages.push({
        message_id: messages.length, role: 'assistant', message: '你回到了现世。', is_hidden: mode === 'hidden',
      });
      if (mode === 'empty') messages.push({ message_id: 1, role: 'assistant', message: ' ', is_hidden: false });
      return '';
    },
  };
  return { bindings: createGlobalDataBindings(host), calls, messages, release };
}
test('实际绑定等待正常正文并回读 AI 楼；不是只调一个成功桩', async () => {
  const h = harness(); await h.bindings.triggerReply();
  assert.deepEqual(h.calls, ['/trigger await=true']);
  assert.equal(h.messages.length, 2);
});
test('异步正文未完成时不提前报告发送成功', async () => {
  const h = harness('deferred'); let finished = false;
  const result = h.bindings.triggerReply().then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false); h.release(); await result; assert.equal(finished, true);
});
test('宿主静默返回、空正文、隐藏回复或插入别的玩家楼不冒充成功，不重发', async () => {
  for (const mode of ['silent', 'empty', 'hidden', 'new-user']) {
    const h = harness(mode);
    await assert.rejects(h.bindings.triggerReply(), /玩家楼已发送，但酒馆未完成正文生成/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.messages.filter(m => m.role === 'user' && m.message.includes('遣返')).length, 1);
  }
});
test('生成中切聊天、回滚改写和宿主报错不能被当作完成', async () => {
  for (const [mode, reason] of [['chat', /聊天已切换/], ['edit', /玩家楼已回滚或改写/], ['error', /host generation error/]] as const) {
    const h = harness(mode); await assert.rejects(h.bindings.triggerReply(), reason);
    assert.equal(h.calls.length, 1);
  }
});
