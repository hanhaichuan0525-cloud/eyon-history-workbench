import type { GenerationAdapter } from '../adapters/host.ts';
import type { RuinContextAssembler, RuinContextBundle } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
// internal.87：地点层级拆分下沉到 core，供 ruin 疆域引用与蝴蝶记忆关键词共用（G-10①）。
import { territorialFragments } from '../core/placeFragments.ts';
import { parseSingleJsonObject } from '../core/json.ts';

export { territorialFragments };
import {
  buildRuinEarlierWindowCutoffReviewPrompt,
  buildRuinEarlierWindowCutoffVerdictPrompt,
  buildRuinExpansionApiPrompt,
  buildRuinExpansionRepairPrompt,
  buildRuinKnownPersonReviewPrompt,
  buildRuinOutlineBatchApiPrompt,
  buildRuinOutlineRepairPrompt,
  requiresRuinEarlierWindowCutoffReview,
  type RuinRuleSet,
} from '../prompts/ruin.ts';
import { mergeTaskCitationRegistries, taskCitationRegistry } from '../retrieval/citations.ts';
import {
  KNOWN_EYON_ERAS,
  RuinGenerationInputSchema,
  type RuinCandidate,
  type RuinGenerationInput,
} from '../schemas/ruin.ts';
import { resolveAutomaticRuinRange } from '../runtime/ruinAutomaticRange.ts';
import {
  buildRuinPresenceDiagnostic,
  recordRuinPresenceDiagnostic,
} from '../runtime/presenceDiagnostics.ts';
import {
  ruinCandidateRecordKey,
  ruinCandidateState,
  type RuinCandidateRecord,
  type RuinCandidateRepository,
} from '../storage/ruins.ts';
import {
  parseAndNormalizeExpandedRuinCandidate,
  parseAndNormalizeRuinOutlines,
  RuinValidationError,
} from '../validators/ruin.ts';
import {
  buildArtifactCanonBindingsSafely,
  mergeArtifactCanonBindings,
  ruinBindingUnits,
} from '../core/artifactCanonBinding.ts';
import type { CanonRepository } from '../storage/canon.ts';
import { assessStagePerson } from '../retrieval/temporal.ts';
import { explicitAgeConflictNames } from '../retrieval/prosePersonReview.ts';

export interface RuinRequestIdentity {
  namespace: WorkbenchNamespace;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  lifecycleEpoch: number;
}

export interface RuinWorkflowDependencies {
  contextAssembler: RuinContextAssembler;
  generator: GenerationAdapter;
  repository: RuinCandidateRepository;
  rules: RuinRuleSet;
  createRequestId(): string;
  now(): number;
  assertCurrent(identity: RuinRequestIdentity): Promise<void>;
  canonRepository?: CanonRepository;
  resolveSelectedCharacters?(selected: RuinGenerationInput['selectedCharacters']): Promise<RuinGenerationInput['selectedCharacters']>;
  onCandidateProgress?(event: {
    stage: 'running' | 'success' | 'failed';
    candidateIndex: number;
    completed: number;
    total: number;
  }): void;
}

export class RuinWorkflow {
  private readonly dependencies: RuinWorkflowDependencies;

  constructor(dependencies: RuinWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  async generate(
    command: WorkbenchCommand,
    rawInput: RuinGenerationInput,
    identity: RuinRequestIdentity,
  ): Promise<RuinCandidateRecord> {
    if (command.type !== 'ruin.generate') {
      throw new Error('Ruin workflow received a different command type');
    }
    const input = RuinGenerationInputSchema.parse(rawInput);
    if (this.dependencies.resolveSelectedCharacters) {
      input.selectedCharacters = await this.dependencies.resolveSelectedCharacters(input.selectedCharacters);
    }
    if (
      input.materials.length !== input.wave.candidateCount
      || new Set(input.materials.map(material => material.candidateKey)).size
        !== input.materials.length
    ) {
      throw new Error('Ruin materials must map one-to-one to candidate count');
    }

    const requestId = this.dependencies.createRequestId();
    const directive = command.raw || 'ruin.generate';
    const context = await this.dependencies.contextAssembler.assemble({
      requestId,
      namespace: identity.namespace,
      triggerMessageId: identity.triggerMessageId,
      directive: buildRuinRetrievalDirective(directive, input),
      territorialReferences: territorialFragments(input.location),
      focusCharacterNames: input.selectedCharacters.map(character => character.name),
      castRequirementQuery: [
        input.era,
        input.location,
        input.supplementaryDirection,
      ].map(value => value.trim()).filter(Boolean).join('\n'),
      eraAnchor: input.era,
      customEra: !KNOWN_EYON_ERAS.includes(input.era as typeof KNOWN_EYON_ERAS[number]),
    });
    if (
      namespaceKey(context.scope) !== namespaceKey(identity.namespace)
      || context.scope.triggerMessageId !== identity.triggerMessageId
    ) {
      throw new Error('Ruin context belongs to a different chat request');
    }

    const rangeResolution = resolveAutomaticRuinRange(
      input,
      context,
      // 点名即进入：补充方向与玩家指令中点名的人物参与出生年下界（无论选不选）。
      [input.supplementaryDirection, directive],
    );
    const effectiveInput = rangeResolution.input;
    // 人物时间锚诊断（工作台可查）：自动范围 + 选中人物锚命中情况 + 注入文本。
    recordRuinPresenceDiagnostic(buildRuinPresenceDiagnostic({
      requestId,
      directive,
      input,
      effectiveInput,
      context,
      rules: this.dependencies.rules,
    }));
    const promptInput = {
      requestId,
      directive,
      generationInput: effectiveInput,
      context,
      rules: this.dependencies.rules,
      automaticTimeRange: rangeResolution.automatic,
    };
    const outlinePrompt = buildRuinOutlineBatchApiPrompt(promptInput);
    let rawResult = await this.dependencies.generator.generate(
      'ruin',
      outlinePrompt,
    );
    let result;
    try {
      result = parseAndNormalizeRuinOutlines(rawResult, {
        requestId,
        directive,
        input: effectiveInput,
        context,
        automaticTimeRange: rangeResolution.automatic,
      });
    } catch (error) {
      if (!(error instanceof RuinValidationError)) throw error;
      // 大纲失败给一次定向修复机会，再失败才终止（对齐传记 plan repair）。
      const repaired = await this.dependencies.generator.generate(
        'ruin',
        buildRuinOutlineRepairPrompt(outlinePrompt, error.message),
      );
      result = parseAndNormalizeRuinOutlines(repaired, {
        requestId,
        directive,
        input: effectiveInput,
        context,
        automaticTimeRange: rangeResolution.automatic,
      });
    }
    await this.dependencies.assertCurrent(identity);
    // 候选重名提示（internal.76 收尾 A3）：warning 只记录不阻断。
    for (const warning of result.castNameWarnings ?? []) {
      console.warn(`[Eyon History Workbench] ${warning}`);
    }
    const createdAt = this.dependencies.now();
    const canonBindings = await this.bindingsFor(
      requestId,
      result,
      context,
      identity.namespace,
      createdAt,
    );
    const record: RuinCandidateRecord = {
      key: ruinCandidateRecordKey(identity.namespace, requestId),
      namespace: identity.namespace,
      requestId,
      triggerMessageId: identity.triggerMessageId,
      triggerTextHash: identity.triggerTextHash,
      triggerSwipeId: identity.triggerSwipeId,
      sourceHash: context.sourceHash,
      citationRegistry: taskCitationRegistry(context.evidenceBundle),
      frozenContext: context,
      input: effectiveInput,
      result,
      expandedCandidateIds: [],
      candidateStates: Object.fromEntries(result.candidates.map(candidate => [
        candidate.id,
        {
          status: 'pending' as const,
          attempt: 0,
          generationEpoch: 0,
          updatedAt: createdAt,
        },
      ])),
      ...(canonBindings.length > 0 ? { canonBindings } : {}),
      createdAt,
    };
    // Keep the previous usable result until the new outline has passed parsing,
    // validation and request-identity checks, then swap the chat namespace once.
    await this.dependencies.repository.replaceNamespace(record);

    // 提纲只负责固定候选之间可比较的历史骨架；在把结果交给玩家选择前，
    // 依次扩写全部候选史稿。单项失败由 expandOne 留在该候选状态中，
    // 不撤销已经完成的兄弟候选，也不阻断后续候选继续生成。
    for (const candidate of result.candidates) {
      try {
        await this.expandCandidate(record.key, candidate.id, identity);
      } catch (error) {
        if (isStaleRequestError(error)) throw error;
      }
    }
    return await this.dependencies.repository.get(record.key) ?? record;
  }

  async expandCandidate(
    recordKey: string,
    candidateId: string,
    identity: RuinRequestIdentity,
  ): Promise<RuinCandidateRecord> {
    const record = await this.dependencies.repository.get(recordKey);
    if (!record) throw new Error('Selected ruin candidate record is unavailable');
    if (namespaceKey(record.namespace) !== namespaceKey(identity.namespace)) {
      throw new Error('Selected ruin candidate belongs to a different chat');
    }
    if (ruinCandidateState(record, candidateId).status === 'ready') return record;
    if (!record.result.candidates.some(item => item.id === candidateId)) {
      throw new Error('Selected ruin candidate does not exist');
    }
    const context = frozenRuinContext(record);
    const index = record.result.candidates.findIndex(item => item.id === candidateId);
    if (index < 0) throw new Error('Selected ruin candidate does not exist');
    return this.expandOne(
      record,
      candidateId,
      context,
      identity,
      index + 1,
      record.result.candidates.length,
    );
  }

  async retryCandidate(
    recordKey: string,
    candidateId: string,
    identity: RuinRequestIdentity,
  ): Promise<RuinCandidateRecord> {
    const record = await this.dependencies.repository.get(recordKey);
    if (!record) throw new Error('Selected ruin candidate record is unavailable');
    if (namespaceKey(record.namespace) !== namespaceKey(identity.namespace)) {
      throw new Error('Selected ruin candidate belongs to a different chat');
    }
    const index = record.result.candidates.findIndex(item => item.id === candidateId);
    if (index < 0) throw new Error('Selected ruin candidate does not exist');
    const context = frozenRuinContext(record);
    return this.expandOne(
      record,
      candidateId,
      context,
      identity,
      index + 1,
      record.result.candidates.length,
    );
  }

  private async expandOne(
    sourceRecord: RuinCandidateRecord,
    candidateId: string,
    context: RuinContextBundle,
    identity: RuinRequestIdentity,
    candidateIndex: number,
    total: number,
  ): Promise<RuinCandidateRecord> {
    await this.dependencies.assertCurrent(identity);
    const latest = await this.dependencies.repository.get(sourceRecord.key);
    if (!latest) throw new Error('Selected ruin candidate record is unavailable');
    const outline = latest.result.candidates.find(item => item.id === candidateId);
    if (!outline) throw new Error('Selected ruin candidate does not exist');
    if (ruinCandidateState(latest, candidateId).status === 'ready') return latest;
    const material = latest.input.materials.find(item =>
      item.candidateKey === outline.candidateKey);
    if (!material) throw new Error('Selected ruin material is unavailable');

    const citationRegistry = mergeTaskCitationRegistries(
      latest.citationRegistry ?? taskCitationRegistry(context.evidenceBundle),
      taskCitationRegistry(context.evidenceBundle),
    );
    const previousState = ruinCandidateState(latest, candidateId);
    const generationEpoch = previousState.generationEpoch + 1;
    const attempt = previousState.attempt + 1;
    const running: RuinCandidateRecord = {
      ...latest,
      citationRegistry,
      candidateStates: {
        ...latest.candidateStates,
        [candidateId]: {
          status: 'generating',
          attempt,
          generationEpoch,
          updatedAt: this.dependencies.now(),
        },
      },
    };
    await this.dependencies.repository.replace(running);
    this.dependencies.onCandidateProgress?.({
      stage: 'running', candidateIndex, completed: readyCount(running), total,
    });

    const requestId = `${latest.requestId}:expand:${candidateId}:${generationEpoch}`;
    const directive = `ruin.expand:${candidateId}`;
    const prompt = buildRuinExpansionApiPrompt({
      requestId,
      directive,
      generationInput: latest.input,
      context,
      rules: this.dependencies.rules,
      citationRegistry,
    }, material, outline);

    try {
      let raw = await this.dependencies.generator.generate('ruin', prompt);
      let expanded;
      try {
        expanded = parseAndNormalizeExpandedRuinCandidate(raw, {
          requestId, input: latest.input, material, context, outline, citationRegistry,
        });
      } catch (error) {
        if (!(error instanceof RuinValidationError)) throw error;
        raw = await this.dependencies.generator.generate(
          'ruin',
          buildRuinExpansionRepairPrompt(prompt, error.message),
        );
        expanded = parseAndNormalizeExpandedRuinCandidate(raw, {
          requestId, input: latest.input, material, context, outline, citationRegistry,
        });
      }
      const ageAssessments = ruinPersonAssessments(expanded, latest.input, context);
      const ageConflicts = explicitAgeConflictNames(expanded.historyProse, ageAssessments);
      if (ageConflicts.length > 0) {
        try {
          const reviewedRaw = await this.dependencies.generator.generate(
            'ruin',
            buildRuinKnownPersonReviewPrompt(prompt, ageConflicts),
          );
          const reviewed = parseAndNormalizeExpandedRuinCandidate(reviewedRaw, {
            requestId, input: latest.input, material, context, outline, citationRegistry,
          });
          const remaining = explicitAgeConflictNames(reviewed.historyProse, ageAssessments);
          if (remaining.length === 0) {
            expanded = reviewed;
          } else {
            console.warn(
              '[Eyon History Workbench] optional ruin person-age review did not resolve the conflict; keeping validated first draft',
              remaining,
            );
          }
        } catch (error) {
          if (isStaleRequestError(error)) throw error;
          console.warn(
            '[Eyon History Workbench] optional ruin person-age review failed; keeping validated first draft',
            error,
          );
        }
      }
      if (requiresRuinEarlierWindowCutoffReview(context.continuityView, {
        era: latest.input.era,
        start: outline.span.start,
        end: outline.span.end,
        automaticTimeRange: false,
      })) {
        const reviewedRaw = await this.dependencies.generator.generate(
          'ruin',
          buildRuinEarlierWindowCutoffReviewPrompt({
            requestId,
            candidateKey: material.candidateKey,
            era: latest.input.era,
            outline,
            candidate: expanded,
          }),
        );
        // 较早时间窗的强制语义门：复核若不能返回合法候选，宁可让该槽位
        // 进入可重试失败态，也不把已经知道未来结局的史稿交给玩家。
        expanded = parseAndNormalizeExpandedRuinCandidate(reviewedRaw, {
          requestId, input: latest.input, material, context, outline, citationRegistry,
        });
        const verdictRaw = await this.dependencies.generator.generate(
          'ruin',
          buildRuinEarlierWindowCutoffVerdictPrompt({
            requestId,
            candidateKey: material.candidateKey,
            era: latest.input.era,
            outline,
            candidate: expanded,
          }),
        );
        if (parseRuinEarlierWindowCutoffVerdict(verdictRaw) !== 'PASS') {
          throw new RuinValidationError(
            'Ruin candidate confirms knowledge beyond the selected historical cutoff',
            'FUTURE_KNOWLEDGE_BLOCKED',
          );
        }
      }
      await this.dependencies.assertCurrent(identity);
      const current = await this.dependencies.repository.get(latest.key);
      if (!current) throw new Error('Selected ruin candidate record is unavailable');
      if (ruinCandidateState(current, candidateId).generationEpoch !== generationEpoch) {
        return current;
      }
      const expandedBindings = await this.bindingsFor(
        current.requestId,
        { ...current.result, candidates: [expanded] },
        context,
        identity.namespace,
        this.dependencies.now(),
      );
      const next: RuinCandidateRecord = {
        ...current,
        result: {
          ...current.result,
          candidates: current.result.candidates.map(candidate =>
            candidate.id === candidateId ? expanded : candidate),
        },
        expandedCandidateIds: current.expandedCandidateIds.includes(candidateId)
          ? current.expandedCandidateIds
          : [...current.expandedCandidateIds, candidateId],
        canonBindings: mergeArtifactCanonBindings(
          current.canonBindings,
          expandedBindings,
        ),
        candidateStates: {
          ...current.candidateStates,
          [candidateId]: {
            status: 'ready', attempt, generationEpoch,
            updatedAt: this.dependencies.now(),
          },
        },
      };
      await this.dependencies.repository.replace(next);
      this.dependencies.onCandidateProgress?.({
        stage: 'success', candidateIndex, completed: readyCount(next), total,
      });
      return next;
    } catch (error) {
      if (!isStaleRequestError(error)) {
        const current = await this.dependencies.repository.get(latest.key);
        if (
          current
          && ruinCandidateState(current, candidateId).generationEpoch === generationEpoch
        ) {
          const failed: RuinCandidateRecord = {
            ...current,
            candidateStates: {
              ...current.candidateStates,
              [candidateId]: {
                status: 'failed', attempt, generationEpoch,
                updatedAt: this.dependencies.now(),
                error: classifyCandidateError(error),
              },
            },
          };
          await this.dependencies.repository.replace(failed);
          this.dependencies.onCandidateProgress?.({
            stage: 'failed', candidateIndex,
            completed: readyCount(failed), total,
          });
        }
      }
      throw error;
    }
  }

  private async bindingsFor(
    artifactId: string,
    result: RuinCandidateRecord['result'],
    context: RuinContextBundle,
    namespace: WorkbenchNamespace,
    createdAt: number,
  ) {
    let branch;
    try {
      branch = await this.dependencies.canonRepository?.getBranch(namespace);
    } catch {
      branch = undefined;
    }
    return buildArtifactCanonBindingsSafely({
      artifactType: 'ruin',
      artifactId,
      view: context.evidenceBundle.canonResolvedView,
      branch,
      units: ruinBindingUnits(result, context.evidenceBundle.passages),
      createdAt,
    });
  }
}

export function parseRuinEarlierWindowCutoffVerdict(raw: string): 'PASS' | 'BLOCK' {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseSingleJsonObject(raw) as Record<string, unknown>;
  } catch (error) {
    throw new RuinValidationError(
      `Invalid ruin cutoff verdict: ${error instanceof Error ? error.message : String(error)}`,
      'CUTOFF_VERDICT_INVALID',
    );
  }
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'verdict'
    || (parsed.verdict !== 'PASS' && parsed.verdict !== 'BLOCK')) {
    throw new RuinValidationError(
      'Ruin cutoff verdict must contain only PASS or BLOCK',
      'CUTOFF_VERDICT_INVALID',
    );
  }
  return parsed.verdict;
}

function ruinPersonAssessments(
  candidate: RuinCandidate,
  input: RuinGenerationInput,
  context: RuinContextBundle,
) {
  const span = {
    start: { era: input.era, year: candidate.span.start.year },
    end: { era: input.era, year: candidate.span.end.year },
  };
  return (context.evidenceBundle.personTimeline ?? [])
    .map(person => assessStagePerson(person, span, input.era));
}

function readyCount(record: RuinCandidateRecord): number {
  return record.result.candidates.filter(candidate =>
    ruinCandidateState(record, candidate.id).status === 'ready').length;
}

function classifyCandidateError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RuinValidationError) {
    return {
      phase: error.code === 'JSON_PARSE_FAILED' ? 'parse' as const : 'validation' as const,
      message,
    };
  }
  if (/(?:HTTP|API|network|fetch|timeout|Premature close|ECONN|Unauthorized)/iu.test(message)) {
    return { phase: 'transport' as const, message };
  }
  return { phase: 'unknown' as const, message };
}

function isStaleRequestError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:lifecycle change|Chat changed|anchor floor changed|request was cancelled|generation was cancelled)/iu.test(message);
}

function frozenRuinContext(record: RuinCandidateRecord): RuinContextBundle {
  if (!record.frozenContext) {
    throw new Error(
      'This legacy ruin record has no frozen evidence session; regenerate the ruin exploration',
    );
  }
  if (record.frozenContext.sourceHash !== record.sourceHash) {
    throw new Error('Frozen ruin evidence session does not match its source hash');
  }
  return record.frozenContext;
}

export function buildRuinRetrievalDirective(
  _directive: string,
  input: RuinGenerationInput,
): string {
  // 注：人物卡全文进检索 query 存在时序死结（检索发生在 context 产生之前），
  // 全文由 prompt 的 <CHARACTER_CARDS_FULL> 直接注入（见 prompts/ruin.ts）。
  const selectedCharacterAnchors = input.selectedCharacters.flatMap(character => [
    character.name,
    character.referenceId ?? '',
    character.identities.join('、'),
    character.professions.join('、'),
    character.race,
    character.relations.join('、'),
    character.lifespan,
    character.contextSummary.slice(0, 800),
  ]);
  return [
    // command.raw 还携带候选骰材、基调与内部命令文本。它们属于创作输入，
    // 不能反向召回同名装备稀有度或无关角色；史料检索只消费玩家事实范围。
    input.era,
    input.location,
    input.supplementaryDirection,
    ...selectedCharacterAnchors,
  ].map(value => value.trim()).filter(Boolean).join('\n');
}

export function selectEnterableRuinNode(
  record: RuinCandidateRecord,
  candidateId: string,
  nodeId: string,
): {
  candidates: RuinCandidateRecord['result'];
  candidate: RuinCandidateRecord['result']['candidates'][number];
  node: RuinCandidateRecord['result']['candidates'][number]['nodes'][number];
} {
  const candidate = record.result.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new Error('Selected ruin candidate does not exist');
  if (ruinCandidateState(record, candidateId).status !== 'ready') {
    throw new Error('请先完成并查看这份墟境史稿，再选择其中的历史阶段进入');
  }
  const node = candidate.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('Selected ruin node does not exist');
  return { candidates: record.result, candidate, node };
}

/**
 * 把玩家填写的「地点范围」拆成候选疆域引用串（按层级分隔符拆分并去除通用词）。
 * internal.87：实现已下沉到 `core/placeFragments.ts`（蝴蝶记忆关键词同源），
 * 此处保留 re-export 以维持既有调用面。
 */
