import {
  TASK_CITATION_REGISTRY_SCHEMA,
  type EvidenceBundle,
  type EvidencePassage,
  type PersonCanonView,
  type SourceSnapshot,
  type TaskCitationRegistry,
} from './contracts.ts';

interface CitationRegistryInput {
  passages: EvidencePassage[];
  personCanonViews?: PersonCanonView[];
  sourceSnapshots: SourceSnapshot[];
}

export type TaskCitationKind = 'passage' | 'fact' | 'event' | 'source';

/**
 * 世界书在宿主 sourceIndex 中使用原名，在检索快照 logicalId 中使用 URL 编码名。
 * 两者描述的是同一个来源，引用合同必须在脚本边界统一成一个身份。
 */
export function canonicalTaskSourceId(value: string): string {
  const sourceId = value.trim();
  const match = /^worldbook:(.*):(-?\d+)$/u.exec(sourceId);
  if (!match) return sourceId;
  return `worldbook:${safeDecodeURIComponent(match[1]!)}:${match[2]}`;
}

/** 确定性构建：同一 EvidenceBundle 永远得到相同的 P/F/S 编号。 */
export function buildTaskCitationRegistry(
  input: CitationRegistryInput,
): TaskCitationRegistry {
  const passageIds = unique([
    ...input.passages.map(passage => passage.passageId),
  ]);
  const factIds = unique(
    (input.personCanonViews ?? []).flatMap(view => view.facts.map(fact => fact.factId)),
  );
  const sourceRows = new Map<string, string[]>();

  for (const snapshot of input.sourceSnapshots) {
    const sourceId = canonicalTaskSourceId(snapshot.logicalId);
    const snapshotIds = sourceRows.get(sourceId) ?? [];
    if (!snapshotIds.includes(snapshot.snapshotId)) snapshotIds.push(snapshot.snapshotId);
    sourceRows.set(sourceId, snapshotIds);
  }
  for (const passage of input.passages) {
    const sourceId = canonicalTaskSourceId(passage.sourceId);
    const snapshotIds = sourceRows.get(sourceId) ?? [];
    if (!snapshotIds.includes(passage.snapshotId)) snapshotIds.push(passage.snapshotId);
    sourceRows.set(sourceId, snapshotIds);
  }

  return {
    schema: TASK_CITATION_REGISTRY_SCHEMA,
    passages: passageIds.map((passageId, index) => ({
      handle: `P${index + 1}`,
      passageId,
    })),
    facts: factIds.map((factId, index) => ({
      handle: `F${index + 1}`,
      factId,
    })),
    events: [],
    sources: [...sourceRows.entries()].map(([sourceId, snapshotIds], index) => ({
      handle: `S${index + 1}`,
      sourceId,
      snapshotIds,
    })),
  };
}

/** 兼容旧 EvidenceBundle：只读地按同一规则补建，不写回缓存。 */
export function taskCitationRegistry(bundle: EvidenceBundle): TaskCitationRegistry {
  const registry = bundle.citationRegistry ?? buildTaskCitationRegistry({
    passages: bundle.passages,
    personCanonViews: bundle.personCanonViews,
    sourceSnapshots: bundle.sourceSnapshots,
  });
  return normalizeTaskCitationRegistry(registry);
}

/** 模型只读的唯一允许表；空数组本身就是合同，不再展示虚构示例。 */
export function renderTaskCitationContract(registry: TaskCitationRegistry): string {
  registry = normalizeTaskCitationRegistry(registry);
  const passageHandle = new Map(registry.passages.map(entry => [entry.passageId, entry.handle]));
  return [
    '<TASK_CITATION_CONTRACT_V2>',
    JSON.stringify({
      schema: registry.schema,
      allowedPassageRefs: registry.passages.map(entry => entry.handle),
      allowedFactRefs: registry.facts.map(entry => entry.handle),
      allowedEventRefs: ['SELF', ...registry.events.map(entry => entry.handle)],
      allowedSourceRefs: registry.sources.map(entry => entry.handle),
      events: registry.events.map(entry => ({
        ref: entry.handle,
        label: entry.label,
        evidencePassageRefs: entry.passageIds.flatMap(id => passageHandle.get(id) ?? []),
      })),
    }),
    '只能逐字使用上表实际列出的句柄。某一 allowed 数组为空时，对应 *Refs 必须为 []；事件表只有 SELF 时，原创开放层事件必须使用 SELF。',
    'P=passage，F=人物 CanonFact，E=世界书/历史事件，S=source。禁止跨类型、猜号、补号、拼接或输出内部 ID。',
    '</TASK_CITATION_CONTRACT_V2>',
  ].join('\n');
}

export function taskCitationHandle(
  registry: TaskCitationRegistry,
  kind: TaskCitationKind,
  targetId: string,
): string | null {
  registry = normalizeTaskCitationRegistry(registry);
  if (kind === 'passage') {
    return registry.passages.find(entry => entry.passageId === targetId)?.handle ?? null;
  }
  if (kind === 'fact') {
    return registry.facts.find(entry => entry.factId === targetId)?.handle ?? null;
  }
  if (kind === 'event') {
    return registry.events.find(entry => entry.eventId === targetId)?.handle ?? null;
  }
  const canonicalTarget = canonicalTaskSourceId(targetId);
  return registry.sources.find(entry =>
    entry.sourceId === canonicalTarget || entry.snapshotIds.includes(targetId))?.handle ?? null;
}

export function resolveTaskCitationHandles(
  registry: TaskCitationRegistry,
  kind: TaskCitationKind,
  handles: string[],
): { targetIds: string[]; unknownHandles: string[] } {
  registry = normalizeTaskCitationRegistry(registry);
  const lookup = new Map<string, string>();
  if (kind === 'passage') {
    for (const entry of registry.passages) lookup.set(entry.handle, entry.passageId);
  } else if (kind === 'fact') {
    for (const entry of registry.facts) lookup.set(entry.handle, entry.factId);
  } else if (kind === 'event') {
    for (const entry of registry.events) lookup.set(entry.handle, entry.eventId);
  } else {
    for (const entry of registry.sources) {
      lookup.set(entry.handle, canonicalTaskSourceId(entry.sourceId));
    }
  }

  const targetIds: string[] = [];
  const unknownHandles: string[] = [];
  for (const handle of unique(handles)) {
    const targetId = lookup.get(handle);
    if (!targetId) {
      unknownHandles.push(handle);
      continue;
    }
    targetIds.push(targetId);
  }
  return { targetIds, unknownHandles };
}

/** 迁移期统一入口：既接受 v2 句柄，也接受已经是本任务内部主键的旧记录。 */
export function resolveTaskCitationValues(
  registry: TaskCitationRegistry,
  kind: TaskCitationKind,
  values: string[],
  allowedInternalIds: Iterable<string> = [],
): { targetIds: string[]; unknownRefs: string[] } {
  registry = normalizeTaskCitationRegistry(registry);
  const allowed = new Set(
    [...allowedInternalIds].map(value =>
      kind === 'source' ? canonicalTaskSourceId(value) : value
    ),
  );
  const targetIds: string[] = [];
  const handles: string[] = [];
  for (const value of unique(values)) {
    const internalId = kind === 'source' ? canonicalTaskSourceId(value) : value;
    if (allowed.has(internalId)) targetIds.push(internalId);
    else handles.push(value);
  }
  const resolved = resolveTaskCitationHandles(registry, kind, handles);
  return {
    targetIds: unique([...targetIds, ...resolved.targetIds]),
    unknownRefs: resolved.unknownHandles,
  };
}

/**
 * 最终模型边界保险：内部 passage/snapshot/source/fact 主键不应穿过 prompt。
 * 先替换最长主键，避免 passageId 被其中的 snapshot/source 子串拆坏。
 */
export function maskTaskCitationIdentifiers(
  value: string,
  registry: TaskCitationRegistry,
): string {
  registry = normalizeTaskCitationRegistry(registry);
  const replacements = [
    ...registry.passages.map(entry => [entry.passageId, entry.handle] as const),
    ...registry.facts.map(entry => [entry.factId, entry.handle] as const),
    ...registry.events.map(entry => [entry.eventId, entry.handle] as const),
    ...registry.sources.flatMap(entry => sourceIdentifierAliases(entry.sourceId, entry.snapshotIds)
      .map(sourceId => [sourceId, entry.handle] as const)),
  ].sort((left, right) => right[0].length - left[0].length);

  return replacements.reduce(
    (text, [internalId, handle]) => internalId ? text.split(internalId).join(handle) : text,
    value,
  );
}

/**
 * 为模块请求中额外冻结的 sourceIndex 追加 S 句柄；既有编号永不重排。
 * 这用于蝴蝶固定锚等不一定进入检索 passage 的只读来源。
 */
export function extendTaskCitationRegistry(
  registry: TaskCitationRegistry,
  sourceIds: string[],
): TaskCitationRegistry {
  const base = normalizeTaskCitationRegistry(registry);
  const existing = new Set(base.sources.map(entry => entry.sourceId));
  const additions = unique(sourceIds.map(canonicalTaskSourceId))
    .filter(sourceId => !existing.has(sourceId));
  let nextHandle = nextSourceHandle(base.sources);
  return {
    ...base,
    passages: base.passages.map(entry => ({ ...entry })),
    facts: base.facts.map(entry => ({ ...entry })),
    events: base.events.map(entry => ({ ...entry, passageIds: [...entry.passageIds] })),
    sources: [
      ...base.sources.map(entry => ({ ...entry, snapshotIds: [...entry.snapshotIds] })),
      ...additions.map(sourceId => ({
        handle: `S${nextHandle++}` as `S${number}`,
        sourceId,
        snapshotIds: [],
      })),
    ],
  };
}

/**
 * 把 S 表投影到最终请求真正携带的 sourceIndex。P/F/E 保持原编号；S 只表达
 * 当前任务可引用的来源，避免检索快照与宿主来源并集制造“合同允许、请求拒绝”。
 */
export function projectTaskCitationRegistrySources(
  registry: TaskCitationRegistry,
  sourceIds: string[],
): TaskCitationRegistry {
  const base = normalizeTaskCitationRegistry(registry);
  const bySourceId = new Map(base.sources.map(entry => [entry.sourceId, entry]));
  const projectedSourceIds = unique(sourceIds.map(canonicalTaskSourceId));
  return {
    ...base,
    passages: base.passages.map(entry => ({ ...entry })),
    facts: base.facts.map(entry => ({ ...entry })),
    events: base.events.map(entry => ({ ...entry, passageIds: [...entry.passageIds] })),
    sources: projectedSourceIds.map((sourceId, index) => ({
      handle: `S${index + 1}` as `S${number}`,
      sourceId,
      snapshotIds: [...(bySourceId.get(sourceId)?.snapshotIds ?? [])],
    })),
  };
}

/** 同一任务跨阶段合并：旧句柄永不换号，新证据只在表尾追加。 */
export function mergeTaskCitationRegistries(
  baseValue: TaskCitationRegistry,
  incomingValue: TaskCitationRegistry,
): TaskCitationRegistry {
  const base = normalizeTaskCitationRegistry(baseValue);
  const incoming = normalizeTaskCitationRegistry(incomingValue);
  const passages = appendCitationRows(base.passages, incoming.passages, 'passageId', 'P');
  const facts = appendCitationRows(base.facts, incoming.facts, 'factId', 'F');
  const events = appendCitationRows(base.events, incoming.events, 'eventId', 'E');
  const sources = base.sources.map(entry => ({ ...entry, snapshotIds: [...entry.snapshotIds] }));
  for (const entry of incoming.sources) {
    const existing = sources.find(item => item.sourceId === entry.sourceId);
    if (existing) {
      existing.snapshotIds = unique([...existing.snapshotIds, ...entry.snapshotIds]);
      continue;
    }
    sources.push({
      ...entry,
      handle: `S${nextSourceHandle(sources)}` as `S${number}`,
      snapshotIds: [...entry.snapshotIds],
    });
  }
  return { schema: TASK_CITATION_REGISTRY_SCHEMA, passages, facts, events, sources };
}

/** 旧记录兼容：v1 注册表没有 events，读取时只补空数组，不猜事件。 */
export function normalizeTaskCitationRegistry(
  registry: TaskCitationRegistry | (Omit<TaskCitationRegistry, 'events'> & { events?: never }),
): TaskCitationRegistry {
  const sources: TaskCitationRegistry['sources'] = [];
  const sourceRows = new Map<string, TaskCitationRegistry['sources'][number]>();
  for (const entry of registry.sources ?? []) {
    const sourceId = canonicalTaskSourceId(entry.sourceId);
    const existing = sourceRows.get(sourceId);
    if (existing) {
      existing.snapshotIds = unique([...existing.snapshotIds, ...(entry.snapshotIds ?? [])]);
      continue;
    }
    const row = {
      ...entry,
      sourceId,
      snapshotIds: unique(entry.snapshotIds ?? []),
    };
    sourceRows.set(sourceId, row);
    sources.push(row);
  }
  return {
    ...registry,
    schema: TASK_CITATION_REGISTRY_SCHEMA,
    passages: (registry.passages ?? []).map(entry => ({ ...entry })),
    facts: (registry.facts ?? []).map(entry => ({ ...entry })),
    events: 'events' in registry && Array.isArray(registry.events)
      ? registry.events.map(entry => ({ ...entry, passageIds: [...entry.passageIds] }))
      : [],
    sources,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sourceIdentifierAliases(sourceId: string, snapshotIds: string[]): string[] {
  const canonical = canonicalTaskSourceId(sourceId);
  const aliases = [sourceId, canonical, ...snapshotIds];
  const match = /^worldbook:(.*):(-?\d+)$/u.exec(canonical);
  if (match) aliases.push(`worldbook:${encodeURIComponent(match[1]!)}:${match[2]}`);
  for (const snapshotId of snapshotIds) {
    const marker = snapshotId.indexOf('@sha256:');
    if (marker > 0) aliases.push(snapshotId.slice(0, marker));
  }
  return unique(aliases);
}

function nextSourceHandle(sources: TaskCitationRegistry['sources']): number {
  return sources.reduce((maximum, entry) => {
    const value = Number.parseInt(entry.handle.slice(1), 10);
    return Number.isFinite(value) ? Math.max(maximum, value) : maximum;
  }, 0) + 1;
}

function appendCitationRows<
  T extends { handle: `${'P' | 'F' | 'E'}${number}` },
  K extends keyof T,
>(base: T[], incoming: T[], key: K, prefix: 'P' | 'F' | 'E'): T[] {
  const rows = base.map(entry => ({ ...entry }));
  const known = new Set(rows.map(entry => String(entry[key])));
  for (const entry of incoming) {
    const id = String(entry[key]);
    if (!id || known.has(id)) continue;
    rows.push({ ...entry, handle: `${prefix}${rows.length + 1}` as T['handle'] });
    known.add(id);
  }
  return rows;
}
