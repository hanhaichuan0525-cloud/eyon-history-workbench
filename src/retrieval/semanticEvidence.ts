import { z } from 'zod';

z.config({ jitless: true });
import type { GenerationAdapter } from '../adapters/host.ts';
import { parseSingleJsonObject } from '../core/json.ts';
import {
  COMPACT_KNOWLEDGE_DIRECTORY_SCHEMA,
  SEMANTIC_EVIDENCE_COMPILER_VERSION,
  SEMANTIC_EVIDENCE_SCHEMA,
  type CompactKnowledgeDirectory,
  type EvidencePassage,
  type KnowledgeEntity,
  type KnowledgeEntityKind,
  type SemanticEvidenceExpansionRequest,
  type SemanticEvidenceView,
  type SourceSnapshot,
  type RetrievalTaskType,
  type WorldKnowledgeCatalog,
} from './contracts.ts';
import { normalizeRetrievalText } from './index.ts';
import { stableSha256 } from './sourceSnapshot.ts';

const KNOWLEDGE_ENTITY_KINDS = [
  'person', 'place', 'organization', 'faction', 'family', 'collective',
  'event', 'era', 'species', 'institution', 'artifact', 'concept', 'unknown',
] as const satisfies readonly KnowledgeEntityKind[];
const EVIDENCE_STATUSES = [
  'explicit', 'structural', 'reported', 'contested', 'inferred', 'unknown',
] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;
const RELEVANCE = ['primary', 'supporting', 'contextual', 'rejected'] as const;

const modelStringList = (max: number) => z.preprocess(
  value => normalizeModelStringList(value, max),
  z.array(z.string()).max(max),
);

const ModelOutputSchema = z.object({
  schema: z.literal(SEMANTIC_EVIDENCE_SCHEMA),
  requestId: z.string().min(1),
  queryPlan: z.object({
    questions: modelStringList(12),
    hypotheses: modelStringList(12),
    prioritizedSnapshotIds: modelStringList(48),
  }).strict(),
  passages: z.array(z.object({
    passageId: z.string().min(1),
    relevance: z.enum(RELEVANCE),
    entities: z.array(z.object({
      entityId: z.string().min(1),
      name: z.string(),
      kind: z.enum(KNOWLEDGE_ENTITY_KINDS),
      status: z.enum(EVIDENCE_STATUSES),
      confidence: z.enum(CONFIDENCES),
      rationale: z.string(),
    }).strict()).max(32),
    spatialScopes: modelStringList(16),
    temporalScopes: modelStringList(16),
    eventKeys: modelStringList(16),
    rationale: z.string(),
  }).strict()).max(96),
  relations: z.array(z.object({
    subjectEntityId: z.string().min(1),
    predicate: z.string().min(1),
    objectEntityId: z.string().min(1),
    passageIds: modelStringList(12).pipe(z.array(z.string()).min(1).max(12)),
    status: z.enum(EVIDENCE_STATUSES),
    confidence: z.enum(CONFIDENCES),
    rationale: z.string(),
  }).strict()).max(64),
  events: z.array(z.object({
    eventKey: z.string().min(1),
    label: z.string().min(1),
    passageIds: modelStringList(16).pipe(z.array(z.string()).min(1).max(16)),
    status: z.enum(EVIDENCE_STATUSES),
    confidence: z.enum(CONFIDENCES),
    rationale: z.string(),
  }).strict()).max(48),
  alternatives: z.array(z.object({
    label: z.string().min(1),
    passageIds: modelStringList(16),
    rationale: z.string(),
  }).strict()).max(16),
  unresolved: modelStringList(24),
  expansionRequest: z.object({
    snapshotIds: modelStringList(8).pipe(z.array(z.string()).min(1).max(8)),
    anchors: modelStringList(16).pipe(z.array(z.string()).min(1).max(16)),
    reason: z.string().min(1),
  }).strict().nullable(),
}).strict();

export interface SemanticEvidenceCompilerInput {
  requestId: string;
  taskType: RetrievalTaskType;
  query: string;
  directory: CompactKnowledgeDirectory;
  passages: EvidencePassage[];
  catalog: WorldKnowledgeCatalog;
  attempt: 1 | 2;
}

export interface SemanticEvidenceCompilation {
  view: SemanticEvidenceView;
  expansionRequest: SemanticEvidenceExpansionRequest | null;
  cacheHit: boolean;
}

export interface SemanticEvidenceCompiler {
  compile(input: SemanticEvidenceCompilerInput): Promise<SemanticEvidenceCompilation>;
}

interface SemanticPromptReferences {
  snapshotIds: Map<string, string>;
  passageIds: Map<string, string>;
  entityIds: Map<string, string>;
}

export class ModelSemanticEvidenceCompiler implements SemanticEvidenceCompiler {
  private readonly cache = new Map<string, SemanticEvidenceCompilation>();
  private readonly generator: GenerationAdapter;

  constructor(generator: GenerationAdapter) {
    this.generator = generator;
  }

  async compile(input: SemanticEvidenceCompilerInput): Promise<SemanticEvidenceCompilation> {
    const cacheKey = await stableSha256({
      compilerVersion: SEMANTIC_EVIDENCE_COMPILER_VERSION,
      taskType: input.taskType,
      query: input.query,
      directory: input.directory.entries.map(entry => entry.snapshotId),
      passages: input.passages.map(passage => [passage.passageId, passage.contentHash]),
      attempt: input.attempt,
    });
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return structuredClone({
        ...cached,
        cacheHit: true,
        view: { ...cached.view, requestId: input.requestId },
      });
    }
    const promptReferences = buildSemanticPromptReferences(input);
    const raw = await this.generator.generate(
      input.taskType,
      renderSemanticEvidencePrompt(input, promptReferences),
      { progressLabel: '正在编译统一史料语义', purpose: 'semantic-evidence' },
    );
    const rawObject = parseSingleJsonObject(raw, {
      schema: SEMANTIC_EVIDENCE_SCHEMA,
      discriminators: { requestId: input.requestId },
    });
    const parsed = resolveSemanticPromptReferences(ModelOutputSchema.parse(
      normalizeSemanticModelOutput(rawObject, input.requestId),
    ), promptReferences);
    if (parsed.requestId !== input.requestId) {
      throw new Error('Semantic evidence compiler returned a mismatched requestId');
    }
    const compiled = sanitizeCompilation(parsed, input);
    this.cache.set(cacheKey, structuredClone(compiled));
    if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value as string);
    return compiled;
  }
}

export function buildCompactKnowledgeDirectory(input: {
  snapshots: SourceSnapshot[];
  catalog: WorldKnowledgeCatalog;
  candidateSnapshotIds: ReadonlySet<string>;
}): CompactKnowledgeDirectory {
  const coverage = new Map(input.catalog.coverage.map(item => [item.snapshotId, item.status]));
  const entitiesBySnapshot = groupEntitiesBySnapshot(input.catalog.entities);
  const entries = input.snapshots.map(snapshot => {
    const detailed = input.candidateSnapshotIds.has(snapshot.snapshotId);
    const entityLimit = detailed ? 12 : 4;
    const entityHints = (entitiesBySnapshot.get(snapshot.snapshotId) ?? [])
      .slice(0, entityLimit)
      .map(entity => ({
        entityId: entity.entityId,
        name: entity.canonicalName,
        kinds: [...entity.kinds],
      }));
    return {
      snapshotId: snapshot.snapshotId,
      logicalId: snapshot.logicalId,
      sourceType: snapshot.sourceType,
      title: snapshot.title,
      coverage: coverage.get(snapshot.snapshotId) ?? 'opaque',
      entityHints,
      headings: extractHeadings(snapshot.content).slice(0, detailed ? 8 : 3),
      preview: snapshot.content.trim().slice(0, detailed ? 240 : 96),
      detailLevel: detailed ? 'candidate' as const : 'catalog-only' as const,
    };
  });
  return {
    schema: COMPACT_KNOWLEDGE_DIRECTORY_SCHEMA,
    entries,
    charCount: JSON.stringify(entries).length,
    detailedEntryCount: entries.filter(entry => entry.detailLevel === 'candidate').length,
  };
}

export function enrichCompactKnowledgeDirectory(input: {
  base: CompactKnowledgeDirectory;
  snapshots: SourceSnapshot[];
  candidateSnapshotIds: ReadonlySet<string>;
}): CompactKnowledgeDirectory {
  const snapshotsById = new Map(input.snapshots.map(snapshot => [snapshot.snapshotId, snapshot]));
  const entries = input.base.entries.map(entry => {
    if (!input.candidateSnapshotIds.has(entry.snapshotId)) return entry;
    const snapshot = snapshotsById.get(entry.snapshotId);
    if (!snapshot) return entry;
    return {
      ...entry,
      headings: extractHeadings(snapshot.content).slice(0, 8),
      preview: snapshot.content.trim().slice(0, 240),
      detailLevel: 'candidate' as const,
    };
  });
  return {
    ...input.base,
    entries,
    charCount: JSON.stringify(entries).length,
    detailedEntryCount: entries.filter(entry => entry.detailLevel === 'candidate').length,
  };
}

export function buildLocalSemanticEvidenceView(input: {
  requestId: string;
  taskType: RetrievalTaskType;
  query: string;
  passages: EvidencePassage[];
  catalog: WorldKnowledgeCatalog;
}): SemanticEvidenceView {
  const entitiesBySnapshot = groupEntitiesBySnapshot(input.catalog.entities);
  const passages = input.passages.map(passage => {
    const entities = passageLocalEntities(
      passage,
      entitiesBySnapshot.get(passage.snapshotId) ?? [],
    ).map(entity => ({
      entityId: entity.entityId,
      name: entity.canonicalName,
      kind: entity.kinds[0] ?? 'unknown' as const,
      status: 'explicit' as const,
      confidence: 'high' as const,
      rationale: 'passage-local literal or source-span evidence',
    }));
    return {
      passageId: passage.passageId,
      relevance: passage.matchedAnchors.length > 0 ? 'primary' as const : 'supporting' as const,
      entities,
      spatialScopes: entities.filter(entity => entity.kind === 'place').map(entity => entity.name),
      temporalScopes: [...passage.temporalScopes],
      eventKeys: [],
      rationale: 'deterministic passage-local fallback; no source-wide entity projection',
    };
  });
  return {
    schema: SEMANTIC_EVIDENCE_SCHEMA,
    requestId: input.requestId,
    taskType: input.taskType,
    compilerVersion: SEMANTIC_EVIDENCE_COMPILER_VERSION,
    queryPlan: { questions: [input.query], hypotheses: [], prioritizedSnapshotIds: [] },
    passages,
    relations: [],
    events: [],
    alternatives: [],
    unresolved: [],
  };
}

/**
 * 语义编译只解释它实际读过的候选段。编译后由脚本本地补入的段落，以及模型
 * 漏列的初始段落，使用 passage-local 确定性绑定补全；不伪造第二次模型判断。
 */
export function completeSemanticEvidenceWithLocalPassages(input: {
  view: SemanticEvidenceView;
  passages: EvidencePassage[];
  catalog: WorldKnowledgeCatalog;
}): SemanticEvidenceView {
  const known = new Set(input.view.passages.map(passage => passage.passageId));
  const missing = input.passages.filter(passage => !known.has(passage.passageId));
  if (missing.length === 0) return input.view;
  const local = buildLocalSemanticEvidenceView({
    requestId: input.view.requestId,
    taskType: input.view.taskType,
    query: input.view.queryPlan.questions[0] ?? '',
    passages: missing,
    catalog: input.catalog,
  });
  return {
    ...input.view,
    passages: [
      ...input.view.passages,
      ...local.passages.map(passage => ({
        ...passage,
        relevance: 'supporting' as const,
        rationale: 'passage-local evidence appended after the single semantic compilation',
      })),
    ],
  };
}

export function passageLocalEntities(
  passage: EvidencePassage,
  entities: KnowledgeEntity[],
): KnowledgeEntity[] {
  const localText = normalizeRetrievalText([
    passage.title,
    ...passage.sectionPath,
    passage.content,
  ].join('\n'));
  return entities.filter(entity => {
    if (!entity.sourceSnapshotIds.includes(passage.snapshotId)) return false;
    const literal = [entity.canonicalName, ...entity.aliases]
      .map(normalizeRetrievalText)
      .filter(value => value.length >= 2)
      .some(value => localText.includes(value));
    if (literal) return true;
    return entity.spans.some(span => span.snapshotId === passage.snapshotId
      && span.startOffset < passage.endOffset
      && span.endOffset > passage.startOffset);
  });
}

function sanitizeCompilation(
  parsed: z.infer<typeof ModelOutputSchema>,
  input: SemanticEvidenceCompilerInput,
): SemanticEvidenceCompilation {
  const passagesById = new Map(input.passages.map(passage => [passage.passageId, passage]));
  const entitiesById = new Map(input.catalog.entities.map(entity => [entity.entityId, entity]));
  const snapshotIds = new Set(input.directory.entries.map(entry => entry.snapshotId));
  const bindings = parsed.passages.flatMap(binding => {
    const passage = passagesById.get(binding.passageId);
    if (!passage) return [];
    return [{
      ...binding,
      entities: binding.entities.flatMap(raw => {
        const entity = entitiesById.get(raw.entityId);
        if (!entity) return [];
        const locallyGrounded = passageLocalEntities(passage, [entity]).length > 0;
        return [{
          ...raw,
          name: entity.canonicalName,
          kind: entity.kinds.includes(raw.kind) ? raw.kind : entity.kinds[0] ?? 'unknown',
          status: locallyGrounded || !['explicit', 'structural'].includes(raw.status)
            ? raw.status : 'inferred' as const,
          confidence: locallyGrounded || raw.confidence !== 'high'
            ? raw.confidence : 'medium' as const,
          rationale: locallyGrounded
            ? raw.rationale
            : `${raw.rationale} [downgraded: no passage-local literal/span evidence]`,
        }];
      }),
    }];
  });
  const knownPassageIds = new Set(bindings.map(binding => binding.passageId));
  const relationEntitiesKnown = (left: string, right: string) =>
    entitiesById.has(left) && entitiesById.has(right);
  const entityIdsByPassage = new Map(bindings.map(binding => [
    binding.passageId,
    new Set(binding.entities.map(entity => entity.entityId)),
  ]));
  const relations = parsed.relations.flatMap(relation => {
    if (!relationEntitiesKnown(relation.subjectEntityId, relation.objectEntityId)
      || !relation.passageIds.every(id => knownPassageIds.has(id))) return [];
    const locallyBound = relation.passageIds.some(id => {
      const entityIds = entityIdsByPassage.get(id);
      return entityIds?.has(relation.subjectEntityId)
        && entityIds.has(relation.objectEntityId);
    });
    return [{
      ...relation,
      status: locallyBound || !['explicit', 'structural'].includes(relation.status)
        ? relation.status : 'inferred' as const,
      confidence: locallyBound || relation.confidence !== 'high'
        ? relation.confidence : 'medium' as const,
      rationale: locallyBound
        ? relation.rationale
        : `${relation.rationale} [downgraded: relation endpoints are not jointly bound by a cited passage]`,
    }];
  });
  const events = parsed.events.filter(event =>
    event.passageIds.every(id => knownPassageIds.has(id)));
  const alternatives = parsed.alternatives.map(item => ({
    ...item,
    passageIds: item.passageIds.filter(id => knownPassageIds.has(id)),
  }));
  const expansionRequest = parsed.expansionRequest && input.attempt === 1
    ? {
      snapshotIds: parsed.expansionRequest.snapshotIds.filter(id => snapshotIds.has(id)),
      anchors: unique(parsed.expansionRequest.anchors),
      reason: parsed.expansionRequest.reason,
    }
    : null;
  return {
    view: {
      schema: SEMANTIC_EVIDENCE_SCHEMA,
      requestId: input.requestId,
      taskType: input.taskType,
      compilerVersion: SEMANTIC_EVIDENCE_COMPILER_VERSION,
      queryPlan: {
        ...parsed.queryPlan,
        prioritizedSnapshotIds: parsed.queryPlan.prioritizedSnapshotIds
          .filter(id => snapshotIds.has(id)),
      },
      passages: bindings,
      relations,
      events,
      alternatives,
      unresolved: unique(parsed.unresolved),
    },
    expansionRequest: expansionRequest?.snapshotIds.length && expansionRequest.anchors.length
      ? expansionRequest : null,
    cacheHit: false,
  };
}

function renderSemanticEvidencePrompt(
  input: SemanticEvidenceCompilerInput,
  references: SemanticPromptReferences,
): string {
  const snapshotRef = reverseReferences(references.snapshotIds);
  const passageRef = reverseReferences(references.passageIds);
  const entityRef = reverseReferences(references.entityIds);
  const contract = {
    schema: SEMANTIC_EVIDENCE_SCHEMA,
    requestId: input.requestId,
    queryPlan: { questions: ['string'], hypotheses: ['string'], prioritizedSnapshotIds: ['S1'] },
    passages: [{
      passageId: 'P1',
      relevance: 'primary|supporting|contextual|rejected',
      entities: [{
        entityId: 'E1', name: 'string', kind: 'existing kind',
        status: 'explicit|structural|reported|contested|inferred|unknown',
        confidence: 'high|medium|low', rationale: 'string',
      }],
      spatialScopes: ['string'], temporalScopes: ['string'], eventKeys: ['string'], rationale: 'string',
    }],
    relations: [{
      subjectEntityId: 'E1', predicate: 'string', objectEntityId: 'E2',
      passageIds: ['P1'], status: 'explicit|structural|reported|contested|inferred|unknown',
      confidence: 'high|medium|low', rationale: 'string',
    }],
    events: [{
      eventKey: 'stable semantic key', label: 'string', passageIds: ['P1'],
      status: 'explicit|structural|reported|contested|inferred|unknown',
      confidence: 'high|medium|low', rationale: 'string',
    }],
    alternatives: [{ label: 'string', passageIds: ['P1'], rationale: 'string' }],
    unresolved: ['string'],
    expansionRequest: input.attempt === 1
      ? { snapshotIds: ['S1'], anchors: ['specific anchor'], reason: 'specific evidence gap' }
      : null,
  };
  const promptDirectory = {
    columns: [
      'snapshotId', 'sourceType', 'title', 'coverage', 'entityHints',
      'headings', 'preview', 'detailLevel',
    ],
    entityHintColumns: ['entityId', 'name', 'kinds'],
    entries: input.directory.entries.map(entry => [
      snapshotRef.get(entry.snapshotId),
      entry.sourceType,
      entry.title,
      entry.coverage,
      entry.entityHints.map(entity => [
        entityRef.get(entity.entityId),
        entity.name,
        entity.kinds,
      ]),
      entry.headings,
      entry.preview,
      entry.detailLevel,
    ]),
  };
  return [
    '<SEMANTIC_EVIDENCE_COMPILER>',
    '你是四模块共享的史料语义证据编译器，不是正文作者，也不是 Canon 仲裁器。',
    '任务：阅读馆藏目录与候选 passage，识别本段实际谈及的人物、地点、组织、事件、时代和关系。',
    '严禁把同一来源其他段出现过的实体投射到当前 passage；固定关键词与同源共现只是候选。',
    '允许跨条目提出有据推断，但必须引用现有 passageId，区分 explicit/structural/reported/contested/inferred/unknown，并保留替代解释。',
    'relevance 只用于建议阅读顺位，不能删除候选 passage，也不能单独制造硬事实或禁用事实。',
    '目录与候选段使用本次任务的短句柄：snapshotId 只能填写 S#，passageId 只能填写 P#，entityId 只能填写 E#。',
    '不得创造句柄或输出内部长 ID；不得决定哪个历史 revision 当前有效。',
    input.attempt === 1
      ? '若候选证据确实不足，只能提出一次具体 expansionRequest；脚本会本地并入所需 passage，不会再次调用你；否则必须为 null。'
      : '不得再次调用语义编译器；expansionRequest 必须为 null。',
    `taskType=${input.taskType}`,
    `query=${JSON.stringify(input.query)}`,
    `<COMPACT_KNOWLEDGE_DIRECTORY>${JSON.stringify(promptDirectory)}</COMPACT_KNOWLEDGE_DIRECTORY>`,
    `<CANDIDATE_PASSAGES>${JSON.stringify(input.passages.map(passage => ({
      passageId: passageRef.get(passage.passageId),
      snapshotId: snapshotRef.get(passage.snapshotId),
      title: passage.title,
      sectionPath: passage.sectionPath,
      temporalScopes: passage.temporalScopes,
      content: passage.content,
    })))}</CANDIDATE_PASSAGES>`,
    `<MANDATORY_FINAL_OUTPUT_CONTRACT>${JSON.stringify(contract)}</MANDATORY_FINAL_OUTPUT_CONTRACT>`,
    '只返回一个 JSON 对象，不要 Markdown、解释或上下文回显。',
    '</SEMANTIC_EVIDENCE_COMPILER>',
  ].join('\n');
}

function buildSemanticPromptReferences(
  input: SemanticEvidenceCompilerInput,
): SemanticPromptReferences {
  const snapshotIds = new Map(input.directory.entries.map((entry, index) => [
    `S${index + 1}`, entry.snapshotId,
  ]));
  const passageIds = new Map(input.passages.map((passage, index) => [
    `P${index + 1}`, passage.passageId,
  ]));
  const entityIds = new Map(unique(input.directory.entries.flatMap(entry =>
    entry.entityHints.map(entity => entity.entityId))).map((entityId, index) => [
    `E${index + 1}`, entityId,
  ]));
  return { snapshotIds, passageIds, entityIds };
}

function resolveSemanticPromptReferences(
  parsed: z.infer<typeof ModelOutputSchema>,
  references: SemanticPromptReferences,
): z.infer<typeof ModelOutputSchema> {
  const resolve = (values: Map<string, string>, value: string) => values.get(value) ?? value;
  const resolveMany = (values: Map<string, string>, items: string[]) =>
    items.map(item => resolve(values, item));
  return {
    ...parsed,
    queryPlan: {
      ...parsed.queryPlan,
      prioritizedSnapshotIds: resolveMany(
        references.snapshotIds,
        parsed.queryPlan.prioritizedSnapshotIds,
      ),
    },
    passages: parsed.passages.map(passage => ({
      ...passage,
      passageId: resolve(references.passageIds, passage.passageId),
      entities: passage.entities.map(entity => ({
        ...entity,
        entityId: resolve(references.entityIds, entity.entityId),
      })),
    })),
    relations: parsed.relations.map(relation => ({
      ...relation,
      subjectEntityId: resolve(references.entityIds, relation.subjectEntityId),
      objectEntityId: resolve(references.entityIds, relation.objectEntityId),
      passageIds: resolveMany(references.passageIds, relation.passageIds),
    })),
    events: parsed.events.map(event => ({
      ...event,
      passageIds: resolveMany(references.passageIds, event.passageIds),
    })),
    alternatives: parsed.alternatives.map(alternative => ({
      ...alternative,
      passageIds: resolveMany(references.passageIds, alternative.passageIds),
    })),
    expansionRequest: parsed.expansionRequest ? {
      ...parsed.expansionRequest,
      snapshotIds: resolveMany(references.snapshotIds, parsed.expansionRequest.snapshotIds),
    } : null,
  };
}

function reverseReferences(references: Map<string, string>): Map<string, string> {
  return new Map([...references].map(([handle, stableId]) => [stableId, handle]));
}

function normalizeModelStringList(value: unknown, max: number): unknown {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        return normalizeModelStringList(JSON.parse(trimmed), max);
      } catch {
        // Treat malformed JSON-looking text as one semantic label.
      }
    }
    return [trimmed];
  }
  if (!Array.isArray(value)) return value;
  return unique(value.filter((item): item is string => typeof item === 'string')).slice(0, max);
}

/**
 * Models frequently return a semantically usable object with harmless schema drift
 * (extra descriptive keys, translated enum labels, or an empty expansion object).
 * Rebuild the public contract field-by-field so one malformed child cannot discard
 * every otherwise grounded passage in the batch. The rebuilt value is still parsed
 * by the strict Zod schema immediately afterwards.
 */
function normalizeSemanticModelOutput(value: unknown, requestId: string): unknown {
  const root = asRecord(value);
  const queryPlan = asRecord(root.queryPlan);
  const passages = asArray(root.passages).flatMap(item => {
    const passage = asRecord(item);
    const passageId = asText(passage.passageId);
    if (!passageId) return [];
    return [{
      passageId,
      relevance: normalizeRelevance(passage.relevance),
      entities: asArray(passage.entities).flatMap(entityValue => {
        const entity = asRecord(entityValue);
        const entityId = asText(entity.entityId);
        if (!entityId) return [];
        return [{
          entityId,
          name: asText(entity.name),
          kind: normalizeEntityKind(entity.kind),
          status: normalizeEvidenceStatus(entity.status),
          confidence: normalizeConfidence(entity.confidence),
          rationale: asText(entity.rationale),
        }];
      }).slice(0, 32),
      spatialScopes: toStringList(passage.spatialScopes, 16),
      temporalScopes: toStringList(passage.temporalScopes, 16),
      eventKeys: toStringList(passage.eventKeys, 16),
      rationale: asText(passage.rationale),
    }];
  }).slice(0, 96);
  const relations = asArray(root.relations).flatMap(item => {
    const relation = asRecord(item);
    const subjectEntityId = asText(relation.subjectEntityId);
    const predicate = asText(relation.predicate);
    const objectEntityId = asText(relation.objectEntityId);
    const passageIds = toStringList(relation.passageIds, 12);
    if (!subjectEntityId || !predicate || !objectEntityId || passageIds.length === 0) return [];
    return [{
      subjectEntityId,
      predicate,
      objectEntityId,
      passageIds,
      status: normalizeEvidenceStatus(relation.status),
      confidence: normalizeConfidence(relation.confidence),
      rationale: asText(relation.rationale),
    }];
  }).slice(0, 64);
  const events = asArray(root.events).flatMap(item => {
    const event = asRecord(item);
    const eventKey = asText(event.eventKey);
    const label = asText(event.label);
    const passageIds = toStringList(event.passageIds, 16);
    if (!eventKey || !label || passageIds.length === 0) return [];
    return [{
      eventKey,
      label,
      passageIds,
      status: normalizeEvidenceStatus(event.status),
      confidence: normalizeConfidence(event.confidence),
      rationale: asText(event.rationale),
    }];
  }).slice(0, 48);
  const alternatives = asArray(root.alternatives).flatMap(item => {
    const alternative = asRecord(item);
    const label = asText(alternative.label);
    if (!label) return [];
    return [{
      label,
      passageIds: toStringList(alternative.passageIds, 16),
      rationale: asText(alternative.rationale),
    }];
  }).slice(0, 16);
  const expansion = asRecord(root.expansionRequest);
  const expansionSnapshotIds = toStringList(expansion.snapshotIds, 8);
  const expansionAnchors = toStringList(expansion.anchors, 16);
  const expansionReason = asText(expansion.reason);

  return {
    schema: SEMANTIC_EVIDENCE_SCHEMA,
    requestId: asText(root.requestId) || requestId,
    queryPlan: {
      questions: toStringList(queryPlan.questions, 12),
      hypotheses: toStringList(queryPlan.hypotheses, 12),
      prioritizedSnapshotIds: toStringList(queryPlan.prioritizedSnapshotIds, 48),
    },
    passages,
    relations,
    events,
    alternatives,
    unresolved: toStringList(root.unresolved, 24),
    expansionRequest: expansionSnapshotIds.length > 0
      && expansionAnchors.length > 0
      && expansionReason
      ? {
        snapshotIds: expansionSnapshotIds,
        anchors: expansionAnchors,
        reason: expansionReason,
      }
      : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toStringList(value: unknown, max: number): string[] {
  const normalized = normalizeModelStringList(value, max);
  return Array.isArray(normalized)
    ? normalized.filter((item): item is string => typeof item === 'string').slice(0, max)
    : [];
}

function normalizeRelevance(value: unknown): typeof RELEVANCE[number] {
  const token = normalizeEnumToken(value);
  if (['primary', 'main', 'core', '主要', '核心', '首要'].includes(token)) return 'primary';
  if (['supporting', 'support', 'secondary', '支持', '支撑', '辅助'].includes(token)) return 'supporting';
  if (['rejected', 'reject', 'irrelevant', '排除', '拒绝', '无关'].includes(token)) return 'rejected';
  return 'contextual';
}

function normalizeEntityKind(value: unknown): typeof KNOWLEDGE_ENTITY_KINDS[number] {
  const token = normalizeEnumToken(value);
  const aliases: Record<string, typeof KNOWLEDGE_ENTITY_KINDS[number]> = {
    character: 'person', npc: 'person', 人物: 'person', 角色: 'person',
    location: 'place', region: 'place', 地点: 'place', 地区: 'place',
    org: 'organization', 组织: 'organization',
    阵营: 'faction', 势力: 'faction', 家族: 'family', 氏族: 'family',
    group: 'collective', 群体: 'collective', 事件: 'event', 历史事件: 'event',
    epoch: 'era', 时代: 'era', 纪元: 'era', 种族: 'species',
    机构: 'institution', 遗物: 'artifact', 神器: 'artifact',
    概念: 'concept', 设定: 'concept',
  };
  if ((KNOWLEDGE_ENTITY_KINDS as readonly string[]).includes(token)) {
    return token as typeof KNOWLEDGE_ENTITY_KINDS[number];
  }
  return aliases[token] ?? 'unknown';
}

function normalizeEvidenceStatus(value: unknown): typeof EVIDENCE_STATUSES[number] {
  const token = normalizeEnumToken(value);
  const aliases: Record<string, typeof EVIDENCE_STATUSES[number]> = {
    direct: 'explicit', 明示: 'explicit', 明确: 'explicit',
    structure: 'structural', 结构性: 'structural',
    hearsay: 'reported', 转述: 'reported', 报告: 'reported',
    disputed: 'contested', 争议: 'contested', 冲突: 'contested',
    inference: 'inferred', 推断: 'inferred', 推测: 'inferred',
  };
  if ((EVIDENCE_STATUSES as readonly string[]).includes(token)) {
    return token as typeof EVIDENCE_STATUSES[number];
  }
  return aliases[token] ?? 'unknown';
}

function normalizeConfidence(value: unknown): typeof CONFIDENCES[number] {
  const token = normalizeEnumToken(value);
  if (['high', 'strong', '高', '高置信'].includes(token)) return 'high';
  if (['medium', 'moderate', '中', '中置信'].includes(token)) return 'medium';
  return 'low';
}

function normalizeEnumToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase('zh-CN') : '';
}

function extractHeadings(content: string): string[] {
  return unique(content.split(/\r?\n/u).flatMap(line => {
    const markdown = line.match(/^\s*#{1,6}\s+(.{2,80}?)\s*$/u)?.[1];
    const field = line.match(/^\s*(?:[-*]\s*)?([^:：<>\[\]{}]{2,60})[:：]/u)?.[1];
    return markdown ?? field ?? [];
  }));
}

function groupEntitiesBySnapshot(
  entities: KnowledgeEntity[],
): Map<string, KnowledgeEntity[]> {
  const result = new Map<string, KnowledgeEntity[]>();
  for (const entity of entities) {
    for (const snapshotId of entity.sourceSnapshotIds) {
      const group = result.get(snapshotId) ?? [];
      group.push(entity);
      result.set(snapshotId, group);
    }
  }
  return result;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
