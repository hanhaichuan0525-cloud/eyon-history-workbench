import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSingleJsonObject } from '../src/core/json.ts';

test('严格 JSON 解析器可从 DeepSeek 思考前言后提取唯一对象', () => {
  assert.deepEqual(
    parseSingleJsonObject('需要仔细分析任务。\n{"schema":"eyon.test","ok":true}\n以上。'),
    { schema: 'eyon.test', ok: true },
  );
});

test('严格 JSON 解析器正确处理字符串内部的花括号', () => {
  assert.deepEqual(
    parseSingleJsonObject('分析：\n{"text":"人物说：{别走}","ok":true}'),
    { text: '人物说：{别走}', ok: true },
  );
});

test('严格 JSON 解析器拒绝多份对象，避免误选错误结果', () => {
  assert.throws(() => parseSingleJsonObject('草稿 {"ok":false}\n最终 {"ok":true}'), error => {
    assert.match(String(error), /multiple JSON objects/u);
    assert.match(String(error), /count=2/u);
    assert.match(String(error), /keys=ok/u);
    return true;
  });
});

test('契约解析器从多个对象中选择最后一份同请求结果', () => {
  const raw = [
    '{"schema":"example.input.v1","requestId":"request-1","value":"输入回显"}',
    '{"schema":"eyon.ruin.candidate.v1","requestId":"other","candidateKey":"c1","value":"其他请求"}',
    '{"schema":"eyon.ruin.candidate.v1","requestId":"request-1","candidateKey":"c1","value":"草稿"}',
    '{"schema":"eyon.ruin.candidate.v1","requestId":"request-1","candidateKey":"c1","value":"最终"}',
  ].join('\n');

  assert.deepEqual(
    parseSingleJsonObject(raw, {
      schema: 'eyon.ruin.candidate.v1',
      discriminators: { requestId: 'request-1', candidateKey: 'c1' },
    }),
    {
      schema: 'eyon.ruin.candidate.v1',
      requestId: 'request-1',
      candidateKey: 'c1',
      value: '最终',
    },
  );
});

test('未闭合外层对象不会把内部时间、因果与节点误判成多份 JSON', () => {
  const truncated = [
    '{"schema":"eyon.ruin.candidate.v1","candidate":{',
    '"span":{"start":145,"end":180,"label":"145—180"},',
    '"causalSummary":{"normalOrder":"A","latentFault":"B"},',
    '"nodes":[{"id":"n1","time":{"year":145,"month":5,"day":20}',
  ].join('');

  assert.throws(() => parseSingleJsonObject(truncated), error => {
    assert.match(String(error), /incomplete JSON object/u);
    assert.doesNotMatch(String(error), /multiple JSON objects/u);
    return true;
  });
});
