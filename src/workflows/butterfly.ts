import type {
  ButterflyHostAdapter,
  GenerationAdapter,
} from '../adapters/host.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  buildButterflyApiPrompt,
  type ButterflyRuleSet,
} from '../prompts/butterfly.ts';
import {
  serializeButterflyArchive,
  serializeButterflyPanel,
} from '../renderers/butterfly.ts';
import {
  butterflyRecordKey,
  type ButterflyRecord,
  type ButterflyRepository,
  type PendingSettlement,
} from '../storage/butterflies.ts';
import { parseAndValidateButterfly } from '../validators/butterfly.ts';
import { linkCarrier, type EntityLinkCandidate } from '../retrieval/entityLinking.ts';
import type { ActiveEvidenceView } from '../prompts/activeEvidence.ts';
import type { CanonFact, InterventionDeltaOperation } from '../retrieval/contracts.ts';
import type { CanonRepository } from '../storage/canon.ts';
import {
  buildArtifactCanonBindingsSafely,
  butterflyBindingUnits,
  mergeArtifactCanonBindings,
} from '../core/artifactCanonBinding.ts';
import { currentBranchActiveStateFacts } from '../runtime/butterflyContext.ts';
import { reconcileCanonIntervention } from './canonReconcile.ts';

type CanonStateEvidence = Pick<
  ActiveEvidenceView,
  'personCanonViews' | 'activeCanonStateFacts'
>;

export class ButterflyWorkflow {
  private readonly generator: GenerationAdapter;
  private readonly repository: ButterflyRepository;
  private readonly host: ButterflyHostAdapter;
  private readonly rules: ButterflyRuleSet;
  private readonly canon?: CanonRepository;
  private readonly now: () => number;

  constructor(dependencies: {
    generator: GenerationAdapter;
    repository: ButterflyRepository;
    host: ButterflyHostAdapter;
    rules: ButterflyRuleSet;
    canonRepository?: CanonRepository;
    now(): number;
  }) {
    this.generator = dependencies.generator;
    this.repository = dependencies.repository;
    this.host = dependencies.host;
    this.rules = dependencies.rules;
    this.canon = dependencies.canonRepository;
    this.now = dependencies.now;
  }

  async settle(pending: PendingSettlement): Promise<ButterflyRecord> {
    let existing = await this.prepare(pending);
    const currentAssistantId = pending.request.trigger.returnAssistantMessageId;
    const needsRebind = (
      existing.assistantMessageId !== currentAssistantId
      || existing.request.trigger.userMessageId
        !== pending.request.trigger.userMessageId
      || existing.request.trigger.rawCommand
        !== pending.request.trigger.rawCommand
    );
    if (needsRebind) {
      if (this.canon && existing.canonRevision !== undefined) {
        await this.canon.rollbackByMessageId(
          existing.namespace,
          existing.assistantMessageId,
          this.now(),
        );
      }
      existing = {
        ...existing,
        request: pending.request,
        assistantMessageId: currentAssistantId,
        status: 'validated',
        revision: existing.revision + 1,
        branchId: undefined,
        canonRevision: undefined,
        actionRef: undefined,
        deltaRef: undefined,
        canonReceipt: undefined,
        canonStatus: undefined,
        updatedAt: this.now(),
      };
      await this.repository.updateRecord(existing);
    } else if (existing.status === 'committed') {
      await this.repository.deletePending(pending.key);
      // internal.81 v21：正文重掷（regenerate）产生的新变体楼里没有面板。
      // 已归档结算不再重入账（Canon/镜像不动），但展示面板按宿主规则补插一次
      // （宿主 appendButterflyPanel 自带幂等与 MVU 前置；失败只降级日志）。
      const targetMessageId = pending.request.trigger.returnAssistantMessageId;
      if (targetMessageId > 0) {
        try {
          await this.host.appendButterflyPanel(
            targetMessageId,
            existing.requestId,
            existing.panel,
          );
        } catch (error) {
          console.warn(
            '[Eyon History Workbench] butterfly panel refresh after reroll failed',
            error,
          );
        }
      }
      return existing;
    }
    return this.resume(existing, pending);
  }

  /**
   * 在遣返正文开始前完成唯一一次蝴蝶效应生成。
   * 此阶段只保存已校验结果，不依赖尚未存在的遣返 AI 楼；
   * 楼层绑定、面板追加、世界书镜像与 Canon 提交仍在 settle 中完成。
   */
  async prepare(pending: PendingSettlement): Promise<ButterflyRecord> {
    const existing = await this.repository.getRecord(
      butterflyRecordKey(pending.namespace, pending.runId),
    );
    // internal.81 v21：删楼回滚会把这轮记录标记为 canonStatus='reverted'。
    // 此时不得复用旧文本（否则档案永远指向已被回滚的 Canon，形成「待人工判断」
    // 死结）——放行重新生成，用新版覆盖同 key 记录。仅 reverted 自动；
    // orphaned（上游连带失效）保持人工判断，不擅自改写。
    if (existing && existing.canonStatus !== 'reverted') return existing;

    const prompt = buildButterflyApiPrompt({
      request: pending.request,
      rules: this.rules,
      activeEvidence: pending.activeEvidence,
    });
    const raw = await this.generator.generate('butterfly', prompt);
    const result = parseAndValidateButterfly(
      raw,
      pending.request,
      pending.activeEvidence,
    );
    // 预结算发生在“遣返”玩家楼建立之后、AI 正文生成之前。这里只锁定
    // 角色卡与聊天；玩家楼已经由 controller 校验，完整双楼身份仍在
    // settle/resume 提交前校验。
    await this.assertNamespace(pending);

    const existingRecords = await this.repository.list(pending.namespace);
    const title = `《蝴蝶效应锚定日志${existingRecords.length + 1}》`;
    const panel = serializeButterflyPanel(result.effect);
    const archiveEntry = serializeButterflyArchive({
      title,
      anchors: pending.request.anchors,
      effect: result.effect,
    });
    const now = this.now();
    let record: ButterflyRecord = {
      key: butterflyRecordKey(pending.namespace, pending.runId),
      namespace: pending.namespace,
      runId: pending.runId,
      requestId: pending.request.requestId,
      request: pending.request,
      result,
      sourceHash: pending.sourceHash,
      panel,
      archiveEntry,
      assistantMessageId: pending.request.trigger.returnAssistantMessageId,
      status: 'validated',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    if (existing) {
      // internal.81 v21：reverted 记录重新生成——同 key 覆盖为新版（旧文本不
      // 留底，旧版只存在于 Canon 版本历史；镜像与面板在 settle 阶段覆盖重写）。
      // saveRecord 拒绝同 key 重复，覆盖必须走 updateRecord。
      record = {
        ...record,
        revision: existing.revision + 1,
        createdAt: existing.createdAt,
      };
      await this.repository.updateRecord(record);
    } else {
      await this.repository.saveRecord(record);
    }
    return record;
  }

  private async resume(
    record: ButterflyRecord,
    pending: PendingSettlement,
  ): Promise<ButterflyRecord> {
    await this.assertCurrent(pending);
    if (record.status === 'validated') {
      await this.host.appendButterflyPanel(
        record.assistantMessageId,
        record.requestId,
        record.panel,
      );
      record = {
        ...record,
        status: 'message_committed',
        revision: record.revision + 1,
        updatedAt: this.now(),
      };
      await this.repository.updateRecord(record);
    }
    if (record.status === 'message_committed' || record.status === 'mirror_pending') {
      // internal.87（§6 步 B）：世界书镜像已退役——面板写入后直接提交 Canon 并归档。
      // 旧记录可能仍带 mirror_pending 状态，按同一条路径收尾（幂等）。
      try {
        const canon = this.canon && record.canonRevision === undefined
          ? await commitButterflyCanon(
            this.canon,
            this.generator,
             record,
             this.now(),
             pending.linkingIndex,
             pending.activeEvidence,
           )
          : null;
        const canonBindings = canon
          ? buildArtifactCanonBindingsSafely({
            artifactType: 'butterfly',
            artifactId: record.runId,
            view: pending.canonBindingView,
            appliedDeltaIds: pending.canonBindingAppliedDeltaIds,
            branch: canon.branch,
            units: butterflyBindingUnits({
              result: record.result,
              actionId: canon.action.actionId,
              delta: canon.delta,
              runId: record.runId,
            }),
            createdAt: this.now(),
          })
          : [];
        record = {
          ...record,
          status: 'committed',
          ...(canon ? {
            branchId: canon.branch.branchId,
            canonRevision: canon.delta.revision,
            actionRef: canon.action.actionId,
            deltaRef: canon.delta.deltaId,
            canonReceipt: canon.receipt,
            canonStatus: canon.delta.status,
          } : {}),
          canonBindings: mergeArtifactCanonBindings(
            record.canonBindings,
            canonBindings,
          ),
          revision: record.revision + 1,
          updatedAt: this.now(),
        };
        await this.repository.updateRecord(record);
        await this.repository.deletePending(pending.key);
      } catch (error) {
        // Canon 提交/归档失败：保留待结算快照供重试（旧字段名沿用，仅为兼容既有记录语义）。
        record = {
          ...record,
          status: 'mirror_pending',
          revision: record.revision + 1,
          updatedAt: this.now(),
        };
        await this.repository.updateRecord(record);
        throw error;
      }
    }
    return record;
  }

  private async assertCurrent(pending: PendingSettlement): Promise<void> {
    await this.assertNamespace(pending);
    const request = pending.request;
    await this.host.assertButterflyTarget({
      requestId: request.requestId,
      userMessageId: request.trigger.userMessageId,
      userSwipeId: pending.triggerSwipeId,
      assistantMessageId: request.trigger.returnAssistantMessageId,
      assistantSwipeId: pending.assistantSwipeId,
      rawCommand: request.trigger.rawCommand,
    });
  }

  private async assertNamespace(pending: PendingSettlement): Promise<void> {
    const request = pending.request;
    const namespace = await this.host.getNamespace();
    if (namespaceKey(namespace) !== namespaceKey({
      characterKey: request.characterKey,
      chatId: request.chatId,
    })) {
      throw new Error('蝴蝶效应返回时角色卡或聊天已经变化');
    }
  }
}

async function commitButterflyCanon(
  repository: CanonRepository,
  generator: GenerationAdapter,
  record: ButterflyRecord,
  now: number,
  linkingIndex?: readonly EntityLinkCandidate[],
  activeEvidence?: ActiveEvidenceView,
) {
  // internal.82（F-01）：把模型命名的载体（carrier）保守归并回冻结检索的稳定
  // 实体 id，使干涉事实与史料实体同空间（后续任务 canon 视图才能命中）。
  // 未命中/多候选命中 → null → 维持 entity:generated 兜底（宁漏勿错）。
  let linkedStages = 0;
  const fallbackCarriers: string[] = [];
  // internal.94：状态承接的最终权威是“提交瞬间的当前 Canon 分支”，不是更早的
  // 冻结检索快照。这样即使 pending 来自重试/回滚恢复，或当时的窄检索没有投递
  // 旧状态，R2「被监禁」→ R5「越狱」仍会在同一提交事务中归并为 replace。
  // 读取/解析失败只降级到原 activeEvidence，不把遣返正文截断。
  const stateEvidence = await currentCommitStateEvidence(
    repository,
    record.namespace,
    activeEvidence,
  );
  const directEffects = dedupeDirectEffects(
    record.result.directEffects ?? [],
    linkingIndex ?? [],
    stateEvidence,
  );
  const directOperations: InterventionDeltaOperation[] = directEffects.map((effect, index) => {
    const subjectEntityId = effect.subjectEntityId;
    if (effect.linked) {
      linkedStages += 1;
    } else {
      fallbackCarriers.push(effect.subject);
    }
    const predicate = effect.predicate;
    const originalFactIds = replaceableDirectPredicates.has(predicate)
      ? matchingCanonFactIds(stateEvidence, subjectEntityId, predicate)
      : [];
    const time = effect.time || record.request.anchors.ruinExit.time;
    const fact: CanonFact = {
      factId: `fact:intervention:${encodeURIComponent(record.runId)}:direct:${index + 1}`,
      subjectEntityId,
      predicate,
      object: ['birth_time', 'death_time', 'established_time', 'created_time'].includes(predicate)
        ? time
        : effect.change,
      statement: effect.change,
      temporalScope: time,
      spatialScope: record.request.anchors.ruinExit.location,
      epistemicStatus: 'generated',
      confidence: 'medium',
      sourceRefs: [...record.result.sourceIds],
      sourceSnapshotIds: [],
      sourceSpans: [],
      revisionIntroduced: 0,
      revisionRetired: null,
    };
    return {
      op: originalFactIds.length > 0 ? 'replace' : 'assert',
      factKey: [
        subjectEntityId,
        predicate,
        predicate === 'historical_change' ? normalizeStable(time) : 'world',
      ].join('|'),
      originalFactIds,
      current: fact,
    };
  });
  const causalOperations: InterventionDeltaOperation[] = record.result.causalStages.map(stage => {
    const linked = linkCarrier(stage.carrier, linkingIndex ?? []);
    const subjectEntityId = linked
      ?? `entity:generated:${encodeURIComponent(normalizeStable(stage.carrier))}`;
    if (linked) {
      linkedStages += 1;
    } else {
      fallbackCarriers.push(stage.carrier);
    }
    const factId = `fact:intervention:${encodeURIComponent(record.runId)}:${stage.order}`;
    const fact: CanonFact = {
      factId,
      subjectEntityId,
      predicate: 'historical_change',
      object: stage.change,
      statement: stage.change,
      temporalScope: stage.time,
      spatialScope: record.request.anchors.ruinExit.location,
      epistemicStatus: 'generated',
      confidence: 'medium',
      sourceRefs: [...stage.sourceIds],
      sourceSnapshotIds: [],
      sourceSpans: [],
      revisionIntroduced: 0,
      revisionRetired: null,
    };
    return {
      op: 'assert' as const,
      factKey: [subjectEntityId, fact.predicate, normalizeStable(stage.time)].join('|'),
      originalFactIds: [],
      current: fact,
    };
  });
  const operations = [...directOperations, ...causalOperations];
  // P3-A：不再让后续代码从叙事正文猜因果。直接变化与因果链首段记为根，
  // 后续阶段只承接模型已经明确给出的 causalStages 顺序；不新增模型调用。
  const causalPlan = {
    directOperationFactKeys: [
      ...directOperations.map(operation => operation.factKey),
      ...(causalOperations[0] ? [causalOperations[0].factKey] : []),
    ],
    supports: causalOperations.slice(1).map((operation, index) => {
      const previousOperation = causalOperations[index];
      const previousStage = record.result.causalStages[index];
      const currentStage = record.result.causalStages[index + 1];
      return {
        inputRefs: [{ kind: 'operation' as const, factKey: previousOperation.factKey }],
        outputFactKey: operation.factKey,
        claimText: previousStage.linkToNext?.trim()
          || `${previousStage.change} → ${currentStage.change}`,
        sourceRefs: [...new Set([
          ...previousStage.sourceIds,
          ...currentStage.sourceIds,
        ])],
      };
    }),
  };
  // internal.82（F-01）：归并留痕（只记录不阻断）。命中稳定实体越多，
  // 干涉越能被后续任务 canon 视图消费；兜底越多说明模型命名与史料脱节。
  // index 摘要（大小 + 前 8 个名字样例）用于真机诊断映射表是否含目标实体。
  if (fallbackCarriers.length > 0 || linkedStages > 0 || (linkingIndex?.length ?? 0) > 0) {
    const indexSamples = (linkingIndex ?? [])
      .slice(0, 8)
      .map(candidate => candidate.names[0]?.slice(0, 16) ?? '')
      .join(' | ');
    console.info(
      '[Eyon History Workbench] butterfly canon linking: '
       + `run=${record.runId} mapped=${linkedStages}/${operations.length} `
      + `fallback=${fallbackCarriers.length} index=${linkingIndex?.length ?? 0}`
      + (indexSamples ? ` samples=[${indexSamples}]` : '')
      + (fallbackCarriers.length > 0
        ? ` carriers=[${fallbackCarriers.join(' | ')}]`
        : ''),
    );
  }
  const intervention = {
    namespace: record.namespace,
    causalPlan,
    action: {
      schema: 'eyon.canon.intervention-action.v1',
      runId: record.runId,
      userMessageId: record.request.trigger.userMessageId,
      assistantMessageId: record.assistantMessageId,
      rawCommand: record.request.trigger.rawCommand,
      actionRecord: record.result.effect.ruinActionRecord,
      sourceRefs: [...record.result.sourceIds],
      occurredAt: { label: record.request.anchors.ruinExit.time },
      createdAt: now,
    },
    delta: {
      schema: 'eyon.canon.intervention-delta.v1',
      effectiveFrom: { label: record.request.anchors.ruinEntry.time },
      operations,
      // P0-B 仅持久化版本骨架；精确前提抽取与交叉重基线留给 P1/P3。
      preconditionFactIds: [...new Set(
        directOperations.flatMap(operation => operation.originalFactIds),
      )],
      dependsOnDeltaIds: [],
      cascadeScope: {
        entityIds: [...new Set(operations.map(operation => operation.current.subjectEntityId))],
        // F-02：补全时间区间与载体名——generated 叙事实体靠「地点/名称/时间」投递
        // 到同窗口任务（见 docs/F02-干涉时空投递-档位2方案）。
        time: {
          start: { label: record.request.anchors.ruinEntry.time },
          end: { label: record.request.anchors.ruinExit.time },
        },
         subjectNames: uniqueButterflyNames(
          [
            ...directEffects.map(effect => effect.subject),
            ...record.result.causalStages.map(stage => stage.carrier),
          ],
        ),
        locations: [...new Set([
          ...record.request.ruinHistory.locationChain,
          record.request.anchors.ruinExit.location,
        ])],
      },
      preserves: record.result.qualityChecks.anchorsUntouched
        ? [
          `reality-time:${record.request.anchors.reality.time}`,
          `reality-location:${record.request.anchors.reality.location}`,
          'player-action-record',
        ]
        : ['player-action-record'],
      supersedesDeltaIds: [],
      status: 'active',
      verified: Object.values(record.result.qualityChecks).every(Boolean),
      createdAt: now,
    },
  } satisfies Parameters<CanonRepository['commitIntervention']>[0];
  const reconciled = await reconcileCanonIntervention({
    repository,
    generator,
    intervention,
    activeEvidence,
  });
  return repository.commitIntervention(reconciled);
}

const replaceableDirectPredicates = new Set([
  'birth_time',
  'death_time',
  'established_time',
  'created_time',
  'custody_status',
  'location_status',
  'role_status',
  'physical_status',
  'ownership_status',
  'object_status',
]);

function directEffectPredicate(stateHint: string): string {
  const hint = normalizeStable(stateHint);
  if (/死亡|身亡|去世|逝世|已故|阵亡|毙命|生命终止/u.test(hint)) return 'death_time';
  if (/出生|诞生|降生/u.test(hint)) return 'birth_time';
  if (/成立|创立|开业|开办|设立/u.test(hint)) return 'established_time';
  if (/建造|建成|落成|竣工|制造|铸造|创造/u.test(hint)) return 'created_time';
  if (/监禁|坐牢|囚禁|羁押|拘禁|越狱|脱狱|获释|释放/u.test(hint)) {
    return 'custody_status';
  }
  if (/地点|所在地|迁居|迁徙|流放|抵达|离开/u.test(hint)) return 'location_status';
  if (/身份|职位|头衔|继承|即位|退位/u.test(hint)) return 'role_status';
  if (/身体|伤势|失能|残疾|失明/u.test(hint)) return 'physical_status';
  if (/所有权|归属|持有/u.test(hint)) return 'ownership_status';
  if (/关系|婚姻|结婚|离婚|结盟|决裂/u.test(hint)) return 'relationship_status';
  if (/物品|物件|道具|器物|遗物|装备|原件|损毁|毁坏|破坏|断裂|遗失|丢失|封存|修复|复原|找回|替换|替代/u.test(hint)) {
    return 'object_status';
  }
  return 'historical_change';
}

function dedupeDirectEffects(
  directEffects: NonNullable<ButterflyRecord['result']['directEffects']>,
  linkingIndex: readonly EntityLinkCandidate[],
  activeEvidence?: CanonStateEvidence,
): Array<NonNullable<ButterflyRecord['result']['directEffects']>[number] & {
  subjectEntityId: string;
  predicate: string;
  linked: boolean;
}> {
  const byState = new Map<string, ReturnType<typeof directEffectRecord>>();
  for (const effect of directEffects) {
    const record = directEffectRecord(effect, linkingIndex, activeEvidence);
    // 同一对象、同一状态维度只落一条最终状态；模型若重复，后项覆盖前项但不报错。
    byState.set(`${record.subjectEntityId}|${record.predicate}`, record);
  }
  return [...byState.values()];
}

function directEffectRecord(
  effect: NonNullable<ButterflyRecord['result']['directEffects']>[number],
  linkingIndex: readonly EntityLinkCandidate[],
  activeEvidence?: CanonStateEvidence,
) {
  const predicate = directEffectPredicate(effect.stateHint);
  const catalogEntityId = linkCarrier(effect.subject, linkingIndex);
  // catalog 未命中时，只在当前 active Canon 的同一状态维度里寻找唯一 generated
  // 对象。这样「玲山」与「玲山·哈姆斯沃思」可承接为 replace；重名/多命中仍
  // 返回 null，继续生成新实体，宁漏勿错。这里不做模糊相似度，也不调用模型。
  const activeGeneratedEntityId = catalogEntityId === null
    ? linkCarrier(effect.subject, activeGeneratedStateCandidates(activeEvidence, predicate))
    : null;
  const linkedEntityId = catalogEntityId ?? activeGeneratedEntityId;
  return {
    ...effect,
    subjectEntityId: linkedEntityId
      ?? `entity:generated:${encodeURIComponent(normalizeStable(effect.subject))}`,
    predicate,
    linked: linkedEntityId !== null,
  };
}

function activeGeneratedStateCandidates(
  activeEvidence: CanonStateEvidence | undefined,
  predicate: string,
): EntityLinkCandidate[] {
  const byId = new Map<string, string>();
  for (const fact of activeEvidence?.activeCanonStateFacts ?? []) {
    if (fact.predicate !== predicate || !fact.subjectEntityId.startsWith('entity:generated:')) {
      continue;
    }
    try {
      const name = decodeURIComponent(fact.subjectEntityId.slice('entity:generated:'.length));
      if (normalizeStable(name).length >= 2) byId.set(fact.subjectEntityId, name);
    } catch {
      // 旧坏 ID 局部忽略，不阻断遣返归档。
    }
  }
  return [...byId].map(([entityId, name]) => ({ entityId, names: [name] }));
}

function matchingCanonFactIds(
  activeEvidence: CanonStateEvidence | undefined,
  subjectEntityId: string,
  predicate: string,
): string[] {
  return [...new Set(
    [
      ...(activeEvidence?.personCanonViews ?? [])
        .filter(view => view.entityId === subjectEntityId)
        .flatMap(view => view.facts)
        .filter(fact => fact.subjectEntityId === subjectEntityId && fact.predicate === predicate)
        .sort((left, right) => right.revisionIntroduced - left.revisionIntroduced)
        .map(fact => fact.factId),
      ...(activeEvidence?.activeCanonStateFacts ?? [])
        .filter(fact => fact.subjectEntityId === subjectEntityId && fact.predicate === predicate)
        .map(fact => fact.factId),
    ],
  )];
}

async function currentCommitStateEvidence(
  repository: CanonRepository,
  namespace: ButterflyRecord['namespace'],
  frozen: ActiveEvidenceView | undefined,
): Promise<CanonStateEvidence> {
  let branchFacts: NonNullable<ActiveEvidenceView['activeCanonStateFacts']> = [];
  try {
    branchFacts = currentBranchActiveStateFacts(await repository.getBranch(namespace));
  } catch {
    // Canon 提交本身仍会给出真实存储错误；这里只保证辅助归并失败不截断正文。
  }
  return {
    personCanonViews: frozen?.personCanonViews ?? [],
    activeCanonStateFacts: [
      ...new Map([
        ...(frozen?.activeCanonStateFacts ?? []),
        ...branchFacts,
      ].map(fact => [fact.factId, fact])).values(),
    ],
  };
}

function normalizeStable(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

/** F-02：载体名归一化去重（有界 8 个、每名 ≤24 字），写入 cascadeScope.subjectNames。 */
function uniqueButterflyNames(carriers: string[]): string[] {
  return [...new Set(
    carriers
      .map(normalizeStable)
      .filter(name => name.length >= 2)
      .slice(0, 8),
  )].map(name => name.slice(0, 24));
}
