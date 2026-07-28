import type {
  HostAdapter,
  UserTurnAdapter,
} from '../adapters/host.ts';
import { namespaceKey } from '../core/namespace.ts';
import { serializeRuinTrace } from '../renderers/ruinTrace.ts';
import type {
  RuinCandidateRecord,
  RuinCandidateRepository,
} from '../storage/ruins.ts';
import { selectEnterableRuinNode } from './ruin.ts';

export interface RuinEntryRealityAnchor {
  time: string;
  location: string;
}

export interface RuinEntrySubmission {
  recordKey: string;
  candidateId: string;
  nodeId: string;
  messageId: number;
  text: string;
}

export function buildRuinEntryText(
  record: RuinCandidateRecord,
  candidateId: string,
  nodeId: string,
  reality: RuinEntryRealityAnchor,
): string {
  const { candidate, node } = selectEnterableRuinNode(
    record,
    candidateId,
    nodeId,
  );
  const realityTime = requireText(reality.time, 'Reality time');
  const realityLocation = requireText(reality.location, 'Reality location');
  const trace = serializeRuinTrace(
    {
      title: candidate.title,
      periodType: periodLabel(candidate.periodType),
      span: candidate.span,
      historyProse: candidate.historyProse,
      shift: `${periodLabel(candidate.shift.from)} → ${periodLabel(candidate.shift.to)}：${candidate.shift.explanation}`,
    },
    node,
  );
  return [
    '进入节点',
    [
      '【历史工作台·单楼进入契约】',
      `现实锚点时间：${realityTime}`,
      `现实锚点地点：${realityLocation}`,
      `目标纪元：${record.result.era}`,
      `目标墟境时间：${node.time.label}`,
      `目标墟境地点：${node.location}`,
      `史案标题：${candidate.title}`,
      `特异点：${node.title}`,
      `节点局势：${node.summary}`,
      `直接成因：${node.cause}`,
      `因果机制：${node.causalMechanism}`,
      `参与人物与组织：${joinOrNone(node.participants)}`,
      `利益与恐惧：${node.interests.map(item =>
        `${item.actor}希望${item.wants}，同时畏惧${item.fears}`
      ).join('；') || '无明确资料'}`,
      `物质条件：${joinOrNone(node.materialConditions)}`,
      `对立关系：${node.opposition || '无明确资料'}`,
      `可感知痕迹：${node.visibleTrace}`,
      `玩家可介入条件：${node.intervention}`,
      `可能分支：${node.possibleBranches.map(branch =>
        `${branch.condition} → ${branch.consequence}`
      ).join('；')}`,
      `参与人物用途：${candidate.selectedCharacterUsage.map(item =>
        `${item.name}（${item.mode}）：${item.role}`
      ).join('；') || '未指定参与人物'}`,
      `玩家补充方向：${record.input.supplementaryDirection.trim() || '无'}`,
      `资料标识：${record.requestId} / ${candidate.id} / ${node.id}`,
      '',
      '请直接承接上一楼尚未结束的动作、人物关系与现场氛围，自然描写从现实锚点进入上述历史节点的过程；不要把史稿复述成说明书。进入完成后，按现有伊雍墟境任务与变量规则，在本楼建立唯一新轮次、锁定现实锚点、把目标时地写入世界与墟境当前时地，并将流程状态更新为 exploring。回复末尾只输出一份完整变量更新。',
    ].join('\n'),
    trace,
  ].join('\n\n');
}

export class RuinEntryWorkflow {
  private readonly inFlight = new Map<string, Promise<RuinEntrySubmission>>();
  private readonly submitted = new Set<string>();
  private readonly repository: RuinCandidateRepository;
  private readonly host: HostAdapter;
  private readonly userTurns: UserTurnAdapter;

  constructor(dependencies: {
    repository: RuinCandidateRepository;
    host: HostAdapter;
    userTurns: UserTurnAdapter;
  }) {
    this.repository = dependencies.repository;
    this.host = dependencies.host;
    this.userTurns = dependencies.userTurns;
  }

  async enter(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<RuinEntrySubmission> {
    const namespace = await this.host.getNamespace();
    const submissionKey = [
      namespaceKey(namespace),
      recordKey,
      candidateId,
      nodeId,
    ].join('::');
    if (this.submitted.has(submissionKey)) {
      throw new Error('This ruin node has already been submitted for entry');
    }
    const existing = this.inFlight.get(submissionKey);
    if (existing) return existing;

    const task = this.submit(
      recordKey,
      candidateId,
      nodeId,
      submissionKey,
    ).finally(() => {
      if (this.inFlight.get(submissionKey) === task) {
        this.inFlight.delete(submissionKey);
      }
    });
    this.inFlight.set(submissionKey, task);
    return task;
  }

  private async submit(
    recordKey: string,
    candidateId: string,
    nodeId: string,
    submissionKey: string,
  ): Promise<RuinEntrySubmission> {
    const [namespace, snapshot, record] = await Promise.all([
      this.host.getNamespace(),
      this.host.getRuinRuntimeSnapshot(),
      this.repository.get(recordKey),
    ]);
    if (!record) throw new Error('Selected ruin candidate record is unavailable');
    if (namespaceKey(record.namespace) !== namespaceKey(namespace)) {
      throw new Error('Selected ruin candidate belongs to a different chat');
    }
    if (snapshot.flowState !== 'idle') {
      throw new Error('A ruin node can only be entered from the idle state');
    }
    const text = buildRuinEntryText(record, candidateId, nodeId, {
      time: snapshot.realityTime,
      location: snapshot.realityLocation,
    });

    const namespaceBeforeSend = await this.host.getNamespace();
    if (namespaceKey(namespaceBeforeSend) !== namespaceKey(namespace)) {
      throw new Error('Chat changed before the ruin entry turn was sent');
    }
    const { messageId } = await this.userTurns.sendUserTurn(text);
    if (!Number.isInteger(messageId) || messageId < 0) {
      throw new Error('Ruin entry sender did not return a valid user floor');
    }
    this.submitted.add(submissionKey);
    return {
      recordKey,
      candidateId,
      nodeId,
      messageId,
      text,
    };
  }
}

function periodLabel(period: 'stable' | 'transition' | 'turbulent'): string {
  return {
    stable: '稳定期',
    transition: '过渡期',
    turbulent: '动荡期',
  }[period];
}

function joinOrNone(items: string[]): string {
  return items.filter(Boolean).join('、') || '无明确资料';
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is unavailable`);
  return normalized;
}
