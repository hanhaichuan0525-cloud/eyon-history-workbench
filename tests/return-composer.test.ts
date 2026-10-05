import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { parseTextCommand } from '../src/core/commands.ts';
import { SerializedTavernUserTurnAdapter } from '../src/runtime/tavernHost.ts';
import type { TavernRuntime } from '../src/runtime/contracts.ts';
import type { TavernDataBindings } from '../src/runtime/tavernHost.ts';

/** 运行真实门面与真实串行发送器，只替换宿主/模型，不向真实聊天发送。 */
function harness(draft: string | null) {
  const tree = ts.createSourceFile('entry.ts', readFileSync(
    new URL('../src/entry.ts', import.meta.url), 'utf8',
  ), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let expression = '';
  const walk = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'returnRuin') expression = node.initializer.getText(tree);
    ts.forEachChild(node, walk);
  };
  walk(tree); assert.ok(expression);
  const messages = [{ message_id: 0, role: 'assistant', message: '探索正文' }];
  const calls: string[] = [];
  const context: any = {
    exports: {}, AbortController, parseTextCommand, draft, changed: false,
    activeReturnTurnController: null, globalObject: {}, prepare: () => {}, confirm: () => {},
    assertWorkbenchEnabled() {},
    runTask: (_: string, task: Function) => task(() => { if (context.changed) throw new Error('chat changed'); }),
    readTavernComposerText: () => context.draft,
    clearTavernComposerText: (text: string) => {
      if (context.draft?.trim() !== text.trim()) return false;
      context.draft = ''; calls.push('clear'); return true;
    },
    butterflyController: {
      prepareBeforeUserTurn: async (text: string, id: number) => {
        calls.push(`prepare:${id}:${text}`); await context.prepare();
      },
      confirmPreparedUserFloor: async (text: string, id: number) => {
        calls.push(`confirm:${id}:${text}`); await context.confirm();
      },
    },
  };
  context.userTurns = new SerializedTavernUserTurnAdapter({
    getLastMessageId: () => messages.at(-1)!.message_id,
    getChatMessages: (id: number) => messages.filter(item => item.message_id === id),
  } as unknown as TavernRuntime, {
    createUserMessage: async (text: string) => {
      calls.push(`create:${text}`);
      messages.push({ message_id: messages.length, role: 'user', message: text });
    },
    triggerReply: async () => { calls.push('trigger'); },
  } as TavernDataBindings, { onUserFloorCreated: text => { context.clearTavernComposerText(text); } });
  runInNewContext(ts.transpileModule(`export const submit = ${expression};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, calls, messages, submit: context.exports.submit as () => Promise<unknown> };
}

test('按钮遣返不要求草稿含命令：保留全文并补指令，同文冻结、建楼、授权后才触发', async () => {
  const draft = '我抱着小花灵走向出口。\n我决定把她带回现世。';
  const h = harness(draft); const text = `${draft}\n\n遣返`;
  await h.submit();
  assert.equal(h.messages.at(-1)?.message, text);
  assert.equal(parseTextCommand(text)?.type, 'ruin.return');
  assert.ok(h.calls.includes(`prepare:1:${text}`));
  assert.ok(h.calls.includes(`confirm:1:${text}`));
  assert.equal(h.context.draft, '');
  assert.ok(h.calls.indexOf('clear') > h.calls.indexOf(`create:${text}`));
  assert.ok(h.calls.indexOf('clear') < h.calls.indexOf('trigger'));
  assert.equal(h.context.activeReturnTurnController, null);
});

test('空框或空白框点击按钮也能遣返，只建立一个玩家楼并触发一次', async () => {
  for (const draft of ['', ' \n\t ']) {
    const h = harness(draft); await h.submit();
    assert.equal(h.messages.at(-1)?.message, '遣返');
    assert.equal(h.messages.length, 2);
    assert.equal(h.calls.filter(call => call === 'trigger').length, 1);
  }
});

test('已有明确返程指令时保留玩家全文，不重复追加命令', async () => {
  const draft = '我把小花灵抱紧。\n好了，遣返吧，伊雍——';
  const h = harness(draft); await h.submit();
  assert.equal(h.messages.at(-1)?.message, draft);
  assert.equal(h.context.draft, '');
});

test('很长的草稿及其他模块命令不被默认语覆盖或截字，末尾明确返程优先', async () => {
  const draft = '寻根溯源：玲山。\n' + '保留这一段行动。'.repeat(360) + '\n末尾仍需保留。';
  const h = harness(draft); await h.submit();
  assert.equal(h.messages.at(-1)?.message, `${draft}\n\n遣返`);
  assert.equal(parseTextCommand(h.messages.at(-1)!.message)?.type, 'ruin.return');
});

test('缺输入框或准备失败时不建楼、不触发、不清草稿', async () => {
  const missing = harness(null);
  await assert.rejects(missing.submit(), /读取酒馆输入框失败/u);
  assert.equal(missing.messages.length, 1); assert.deepEqual(missing.calls, []);
  const h = harness('尚未写完的草稿');
  h.context.prepare = () => { throw new Error('资料准备失败'); };
  await assert.rejects(h.submit(), /资料准备失败/u);
  assert.equal(h.messages.length, 1); assert.equal(h.context.draft, '尚未写完的草稿');
  assert.ok(!h.calls.includes('trigger')); assert.equal(h.context.activeReturnTurnController, null);
});

test('等待准备时切聊天或停止任务，不发送捕获的草稿', async () => {
  for (const cancel of [true, false]) {
    const h = harness('准备遣返');
    h.context.prepare = () => {
      if (cancel) h.context.activeReturnTurnController.abort(new Error('cancelled'));
      else h.context.changed = true;
    };
    await assert.rejects(h.submit(), /cancelled|chat changed/u);
    assert.equal(h.messages.length, 1); assert.equal(h.context.draft, '准备遣返');
    assert.ok(!h.calls.includes('trigger'));
  }
});

test('准备期间后来输入的新草稿不被清空；已发送但授权失败不重复触发', async () => {
  const h = harness('原来的行动');
  h.context.prepare = () => { h.context.draft = '后来写的新草稿'; };
  await h.submit(); assert.equal(h.context.draft, '后来写的新草稿');
  assert.equal(h.messages.at(-1)?.message, '原来的行动\n\n遣返');
  const failed = harness('行动已经写好');
  failed.context.confirm = () => { throw new Error('授权失败'); };
  await assert.rejects(failed.submit(), /授权失败/u);
  assert.equal(failed.messages.length, 2); assert.equal(failed.context.draft, '');
  assert.ok(!failed.calls.includes('trigger'));
});
