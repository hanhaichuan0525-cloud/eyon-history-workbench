import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuinNode } from '../src/schemas/ruin.ts';
import {
  formatRuinNodeExactTime,
  fullRuinStageIntroduction,
} from '../src/ui/ruinPresentation.ts';

function makeNode(): RuinNode {
  return {
    id: 'node-anomaly',
    kind: 'anomaly',
    time: {
      year: 485,
      month: 3,
      day: 12,
      hour: 14,
      minute: 5,
      label: '旧标签不应成为展示权威',
    },
    location: '金谷城地下金库',
    title: '档案大火的阴谋',
    summary: '这是一段必须完整显示、不能在节点卡中截断的阶段介绍。',
    cause: '秘密账簿被人调换。',
    causalMechanism: '账簿调换使商业契约的利益分配失衡。',
    participants: ['夜莺巷旧行会'],
    materialConditions: ['地下金库', '封存账簿'],
    opposition: '守库人员与旧行会的利益冲突。',
    visibleTrace: '矿石上留有黑色琉璃状高温烧结痕迹。',
    intervention: '提前转移或公开账簿。',
    possibleBranches: [{
      condition: '账簿在大火前被转移。',
      consequence: '地下金库的秘密不再能被火灾彻底抹除。',
    }],
    enterable: true,
    inference: false,
    interests: [{
      actor: '夜莺巷旧行会',
      wants: '保住账册',
      fears: '地下金库暴露',
    }],
    sourceRefs: [],
  };
}

test('因果节点以结构化字段显示精确到时分的时间', () => {
  assert.equal(
    formatRuinNodeExactTime('复兴纪元', makeNode().time),
    '复兴纪元485年3月12日14:05',
  );
});

test('旧记录缺少日期字段时不会虚构年月日时', () => {
  const time = { ...makeNode().time, month: null, day: null, hour: null, minute: null };
  assert.equal(
    formatRuinNodeExactTime('复兴纪元', time),
    '复兴纪元485年（月、日、时未详）',
  );
});

test('绿色详情框使用未经截断的完整阶段介绍', () => {
  const node = makeNode();
  assert.equal(fullRuinStageIntroduction(node), node.summary);
});
