import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPromptDiagnosticsForTest,
  listPromptDiagnostics,
  recordPromptDiagnostic,
} from '../src/runtime/promptDiagnostics.ts';

test('Prompt 诊断只记录字符数、阶段与 requestId，不保存正文', () => {
  clearPromptDiagnosticsForTest();
  const prompt = [
    '<QUALIFIED_EVIDENCE_VIEW>',
    '{"requestId":"diag-1","schema":"eyon.ruin.outlines.v1"}',
    '</QUALIFIED_EVIDENCE_VIEW>',
  ].join('\n');
  recordPromptDiagnostic({
    taskType: 'ruin',
    prompt,
    systemPrompt: 'system',
    attempt: 1,
    compactRecovery: false,
  });
  const [entry] = listPromptDiagnostics();
  assert.equal(entry.stage, 'outline');
  assert.equal(entry.requestId, 'diag-1');
  assert.equal(entry.promptChars, prompt.length);
  assert.equal(entry.systemChars, 6);
  assert.equal(entry.totalChars, prompt.length + 6);
  assert.ok(entry.qualifiedEvidenceChars > 0);
  assert.equal(entry.personCanonChars, 0);
  assert.equal(entry.passageEvidenceChars, 0);
  assert.equal(entry.taskAnchorAttachmentChars, 0);
  assert.equal('prompt' in entry, false);
});

test('传记规划不会因生成规则提到 passage schema 而误报为正文阶段', () => {
  clearPromptDiagnosticsForTest();
  const prompt = [
    '<generation_contract>eyon.biography.passage.v1</generation_contract>',
    '<PERSON_CANON_VIEW>人物事实</PERSON_CANON_VIEW>',
    '<TASK_ANCHOR_ATTACHMENT>完整人物条目</TASK_ANCHOR_ATTACHMENT>',
    '<BIOGRAPHY_PLAN_MANDATORY_OUTPUT_CONTRACT>',
    '{"requestId":"bio-diag-1"}',
    '</BIOGRAPHY_PLAN_MANDATORY_OUTPUT_CONTRACT>',
  ].join('\n');
  recordPromptDiagnostic({
    taskType: 'biography',
    prompt,
    systemPrompt: '',
    attempt: 1,
    compactRecovery: false,
  });
  const [entry] = listPromptDiagnostics();
  assert.equal(entry.stage, 'plan');
  assert.ok(entry.personCanonChars > 0);
  assert.ok(entry.taskAnchorAttachmentChars > 0);
});

test('Prompt 诊断不会因扩写提示词携带 outline schema 而误报为大纲', () => {
  clearPromptDiagnosticsForTest();
  const prompt = [
    '<RUIN_SELECTED_CANDIDATE_EXPANSION>',
    '{"requestId":"diag:expand:ruin-1:1","schema":"eyon.ruin.outlines.v1"}',
    '</RUIN_SELECTED_CANDIDATE_EXPANSION>',
  ].join('\n');
  recordPromptDiagnostic({
    taskType: 'ruin',
    prompt,
    systemPrompt: '',
    attempt: 1,
    compactRecovery: false,
  });
  assert.equal(listPromptDiagnostics()[0]?.stage, 'expansion');
});

test('P4-C2 截止改写与独立裁决拥有可区分的内存诊断阶段', () => {
  clearPromptDiagnosticsForTest();
  for (const prompt of [
    '<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>{"requestId":"cutoff-1"}</RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>',
    '<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>{"requestId":"cutoff-1"}</RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>',
  ]) {
    recordPromptDiagnostic({
      taskType: 'ruin',
      prompt,
      systemPrompt: '',
      attempt: 1,
      compactRecovery: false,
    });
  }
  assert.deepEqual(
    listPromptDiagnostics().map(entry => entry.stage),
    ['expansion-cutoff-review', 'expansion-cutoff-verdict'],
  );
});

test('P0-D 语义证据编译拥有独立阶段与字符诊断', () => {
  clearPromptDiagnosticsForTest();
  recordPromptDiagnostic({
    taskType: 'ruin',
    prompt: '<SEMANTIC_EVIDENCE_COMPILER>{"requestId":"semantic-1"}</SEMANTIC_EVIDENCE_COMPILER>',
    systemPrompt: 'semantic',
    attempt: 1,
    compactRecovery: false,
  });
  const [entry] = listPromptDiagnostics();
  assert.equal(entry.stage, 'semantic-evidence');
  assert.ok(entry.semanticEvidenceChars > 0);
});
