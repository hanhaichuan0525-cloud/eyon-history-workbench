import assert from 'node:assert/strict';
import test from 'node:test';

import { createBiographyStagePlanFromRules } from '../src/runtime/biographyDiceCore.ts';
import {
  assertBiographyRootTraceMatchesStructuredData,
  parseBiographyRootTrace,
  renderBiographyRootTrace,
} from '../src/renderers/rootTrace.ts';
import { resolveBiographyDisplayIdentity } from '../src/renderers/biographyIdentity.ts';

const diceRules = `
# table_1_stage_count
01-45: 5
46-75: 6
76-92: 7
93-100: 8

# table_2_stable
01-100 | stable-a | Stable material | Quiet accumulation

# table_3_transition
01-100 | transition-a | Transition material | Meaning changes

# table_4_turbulent
01-100 | turbulent-a | Turbulent material | Conflict erupts
`;

test('biography dice plan locks the old five-to-eight stage contract', () => {
  for (const randomValue of [0, 0.5, 0.8, 0.99]) {
    const plan = createBiographyStagePlanFromRules(diceRules, () => randomValue);
    assert.ok(plan.count >= 5 && plan.count <= 8);
    assert.equal(plan.stages.length, plan.count);
    assert.equal(new Set(plan.stages.map(stage => stage.type)).size, 3);
    plan.stages.forEach((stage, index) => {
      assert.equal(stage.id, `stage-${index + 1}`);
      assert.notEqual(stage.type, plan.stages[index - 1]?.type);
      if (stage.type === 'turbulent') {
        assert.equal(plan.stages[index + 1]?.type, 'transition');
      }
    });
  }
});

test('deterministic RootTrace renderer preserves the legacy regex contract', () => {
  const biography = {
    playerDirective: { primaryDirection: 'Imperial & private history' },
    target: { name: 'Violeta & Augusta' },
    presentation: {
      title: 'Violeta & Augusta archive',
      subtitle: 'Private rooms reveal an empire',
    },
    span: { label: 'age 24 to 28' },
    origin: { title: '起源(24岁)', content: 'origin <prose> & “memory”' },
    stages: [{
      type: 'stable' as const,
      title: 'ignored model title',
      span: '24岁至25岁',
      content: 'stage prose & archive',
    }],
    status: { title: '现状(28岁)', content: 'status prose' },
    summary: 'summary prose',
  };
  const rootTrace = renderBiographyRootTrace(biography);

  const fields = [
    'Title:: 《Violeta &amp; Augusta archive》',
    'Subtitle:: Private rooms reveal an empire',
    'Span:: age 24 to 28',
    'OriginTitle:: 起源(24岁)',
    'Origin:: origin &lt;prose&gt; &amp;',
    'Periods:: ',
    'StatusTitle:: 现状(28岁)',
    'Status:: status prose',
    'Summary:: summary prose',
  ];
  let cursor = -1;
  for (const field of fields) {
    const next = rootTrace.indexOf(field);
    assert.ok(next > cursor, `field order drifted at ${field}`);
    cursor = next;
  }
  assert.match(rootTrace, /<details class="eybi-stage">/u);
  assert.match(rootTrace, /<summary class="eybi-stage-title">ignored model title｜稳定期\(24岁至25岁\)<\/summary>/u);
  assert.match(rootTrace, /<div class="eybi-v eybi-pre eybi-entries">stage prose &amp; archive<\/div>/u);
  assert.doesNotMatch(rootTrace, /Augusta传/u);
  assert.equal(parseBiographyRootTrace(rootTrace).title, 'Violeta & Augusta archive');
  assert.doesNotMatch(rootTrace, /Subtitle:: Imperial &amp; private history/u);
  assert.doesNotThrow(() => assertBiographyRootTraceMatchesStructuredData(biography, rootTrace));
});

test('RootTrace semantic check tolerates representation artifacts but rejects authored drift', () => {
  const biography = {
    playerDirective: { primaryDirection: '宫廷史' },
    target: { name: '维奥莱塔' },
    span: { label: '24岁至28岁' },
    origin: { title: '起源(24岁)', content: '原始正文 & 档案' },
    stages: [{
      type: 'transition' as const,
      title: 'unused',
      span: '24岁至28岁',
      content: '阶段正文',
    }],
    status: { title: '现状(28岁)', content: '现状正文' },
    summary: '总结正文',
  };
  const rootTrace = renderBiographyRootTrace(biography);
  const crlf = rootTrace.replaceAll('\n', '\r\n');
  assert.doesNotThrow(() => assertBiographyRootTraceMatchesStructuredData(biography, crlf));
  assert.throws(
    () => assertBiographyRootTraceMatchesStructuredData(
      biography,
      rootTrace.replace('阶段正文', '阶段，正文'),
    ),
    /stages\[0\]\.content/u,
  );
});

test('RootTrace field-like prose and Unicode round-trip without changing field boundaries', () => {
  const decomposed = 'e\u0301';
  const biography = {
    playerDirective: { primaryDirection: `宫廷史\nSummary:: 这是正文，不是字段` },
    target: { name: `维奥莱塔${decomposed}` },
    span: { label: '24岁至28岁' },
    origin: {
      title: '起源(24岁)',
      content: `第一行 & <档案>\r\nPeriods:: 这是正文，不是字段`,
    },
    stages: [{
      type: 'stable' as const,
      title: 'unused',
      span: '24岁至28岁',
      content: `阶段正文\nStatusTitle:: 仍是阶段正文`,
    }],
    status: {
      title: '现状(28岁)',
      content: `现状正文\nSummary:: 仍是现状正文`,
    },
    summary: `总结正文\n[/RootTrace] 只是文本`,
  };
  const rootTrace = renderBiographyRootTrace(biography);

  assert.match(rootTrace, /&#10;Periods::/u);
  assert.match(rootTrace, /&#10;StatusTitle::/u);
  assert.equal(parseBiographyRootTrace(rootTrace).stages.length, 1);
  assert.equal(
    parseBiographyRootTrace(rootTrace).title,
    resolveBiographyDisplayIdentity(biography).titleText,
  );
  assert.doesNotThrow(() => assertBiographyRootTraceMatchesStructuredData(biography, rootTrace));
});

test('RootTrace preserves literal entity-like prose instead of decoding authored source text', () => {
  const biography = {
    playerDirective: { primaryDirection: '档案中的 &amp; 与 &#10; 应视为原文' },
    target: { name: '实体 &lt; 测试者' },
    span: { label: '复兴纪元430年至488年' },
    origin: {
      title: '起源(复兴纪元430年)',
      content: '原始档案写有 &amp;、&lt; 与 &#10;，这些字符序列本身就是史料。',
    },
    stages: [{
      type: 'transition' as const,
      title: 'unused',
      span: '复兴纪元445年至451年',
      content: '抄本同时保留 &quot;旧称&quot; 与 &#039;边注&#039;。',
    }],
    status: {
      title: '现状(复兴纪元488年)',
      content: '现存目录仍逐字记录 &amp;amp;，不得递归解码。',
    },
    summary: '传记应忠实保留实体样式的原始文字。',
  };
  const rootTrace = renderBiographyRootTrace(biography);
  const parsed = parseBiographyRootTrace(rootTrace);

  assert.equal(parsed.title, resolveBiographyDisplayIdentity(biography).titleText);
  assert.equal(parsed.origin, biography.origin.content);
  assert.equal(parsed.stages[0]?.content, biography.stages[0]?.content);
  assert.equal(parsed.status, biography.status.content);
  assert.doesNotThrow(() => assertBiographyRootTraceMatchesStructuredData(biography, rootTrace));
});
