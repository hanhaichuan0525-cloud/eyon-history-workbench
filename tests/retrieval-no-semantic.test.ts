import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildActiveEvidenceView,
  renderActiveEvidenceBlock,
} from '../src/prompts/activeEvidence.ts';
import { UnifiedShadowRetrievalEngine } from '../src/retrieval/shadowEngine.ts';
import { createSourceSnapshot } from '../src/retrieval/sourceSnapshot.ts';

test('四模块共享检索直接冻结本地 EvidenceBundle，不产生语义编译视图或回执', async () => {
  const source = await createSourceSnapshot({
    logicalId: 'worldbook:命定之诗与黄昏之歌:697939',
    sourceType: 'worldbook' as const,
    title: '[奥古斯提姆帝国]',
    content: '英雄纪元第二次位面入侵期间，帝国军方在边境组织将士抵御异界冲击。',
    sourceOrder: 0,
    metadata: {},
  });
  const result = await new UnifiedShadowRetrievalEngine([source]).retrieve({
    requestId: 'no-semantic-compiler',
    taskType: 'ruin',
    query: '英雄纪元 奥古斯提姆帝国 第二次位面入侵 帝国军方英雄群像',
    mode: 'active',
  });

  assert.ok(result.bundle.passages.length > 0);
  assert.equal(result.bundle.semanticEvidence, undefined);
  assert.equal(result.bundle.receipt.semanticEvidence, undefined);
  assert.ok(result.bundle.citationRegistry);
  assert.ok((result.bundle.citationRegistry?.passages.length ?? 0) > 0);
  assert.ok((result.bundle.citationRegistry?.sources.length ?? 0) > 0);

  const promptBlock = renderActiveEvidenceBlock(
    buildActiveEvidenceView(result.bundle, '英雄纪元'),
  );
  assert.match(promptBlock, /<TASK_CITATION_CONTRACT_V2>/u);
  assert.doesNotMatch(promptBlock, /SEMANTIC_EVIDENCE/u);
});

test('当前 revision 的时间原点以只读自然语言块进入四模块公共证据，不增加必填输出', () => {
  const promptBlock = renderActiveEvidenceBlock({
    requestedEra: null,
    qualifiedEvidence: null,
    eraProfile: null,
    personTimeline: [],
    castManifest: null,
    temporalRules: [],
    territorial: [],
    passages: [],
    canonResolvedView: {
      viewId: 'canon-view:temporal-origin',
      branchId: 'canon:temporal-origin',
      resolvedRevision: 2,
      queryScopeHash: 'temporal-origin-scope',
      activeRevisionFacts: [],
      currentTemporalOrigins: [{
        statement: '玲山·哈姆斯沃思的出生时间为复兴纪元463年',
        predicate: 'birth_time',
        time: '复兴纪元463年',
        source: 'intervention',
      }],
      uncertainItems: [],
    },
  });

  assert.match(promptBlock, /<CURRENT_TEMPORAL_ORIGINS_READ_ONLY>/u);
  assert.match(promptBlock, /复兴纪元463年/u);
  assert.match(promptBlock, /不得拿某次事件中的年龄或时长反推另一套原点/u);
  assert.match(promptBlock, /玩家干涉后的现行值/u);
});
