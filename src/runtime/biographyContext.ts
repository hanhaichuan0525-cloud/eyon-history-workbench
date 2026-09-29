import type {
  BiographyContextAssembler,
  BiographyContextBundle,
  ContextSource,
} from '../core/context.ts';
import {
  loadRuntimeWorldbookCorpus,
  type TavernRuntime,
  type RuntimeContextSourceProvider,
} from './contracts.ts';
import { selectRelevantContextSources } from './sourceSelection.ts';
import type { RetrievalShadowCapture } from '../retrieval/runtimeShadow.ts';
import type { CanonBranch, CanonResolvedView, EvidenceBundle } from '../retrieval/contracts.ts';
import { resolveActiveRetrieval } from './activeRetrieval.ts';
import { absoluteYear } from '../retrieval/temporal.ts';
import type { CanonRepository } from '../storage/canon.ts';
import {
  buildCurrentSceneSnapshot,
  type CurrentSceneSnapshot,
} from '../core/currentSceneReference.ts';
import type { BiographyRepository } from '../storage/biographies.ts';
import { buildContinuityViewSafely } from './continuityAnchors.ts';
import type { ContinuityView } from '../core/continuityAnchors.ts';
import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';

const RECENT_MESSAGE_LIMIT = 6;
const CURRENT_SCENE_MESSAGE_LIMIT = 12;
const RECENT_CONTENT_LIMIT = 2000;
const CONTENT_LIMIT = 12000;

export class TavernBiographyContextAssembler implements BiographyContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;
  private readonly retrievalShadow?: RetrievalShadowCapture;
  /** 年龄基准时间 ensure（按聊天开局锁定）；未提供则 null。 */
  private readonly ensureBaselineTime?: (
    namespace: WorkbenchNamespace,
    currentWorldTime: string,
  ) => string;
  private readonly canonRepository?: CanonRepository;
  private readonly biographyRepository?: BiographyRepository;

  constructor(
    runtime: TavernRuntime,
    sources: RuntimeContextSourceProvider,
    retrievalShadow?: RetrievalShadowCapture,
    ensureBaselineTime?: (
      namespace: WorkbenchNamespace,
      currentWorldTime: string,
    ) => string,
    canonRepository?: CanonRepository,
    biographyRepository?: BiographyRepository,
  ) {
    this.runtime = runtime;
    this.sources = sources;
    this.retrievalShadow = retrievalShadow;
    this.ensureBaselineTime = ensureBaselineTime;
    this.canonRepository = canonRepository;
    this.biographyRepository = biographyRepository;
  }

  async assemble(input: {
    requestId: string;
    namespace: { characterKey: string; chatId: string };
    triggerMessageId: number;
    directive: string;
  }): Promise<BiographyContextBundle> {
    const [
      currentWorld,
      worldbookCorpus,
      characters,
      genealogy,
      biographies,
      butterflies,
    ] = await Promise.all([
      this.sources.getCurrentWorld(),
      loadRuntimeWorldbookCorpus(this.sources),
      this.sources.getCharacterSources(),
      this.sources.getGenealogySources(),
      this.sources.getBiographySources(),
      this.sources.getButterflySources(),
    ]);
    const worldbook = worldbookCorpus.sources;
    const recentWindow = this.buildRecentSources(
      input.triggerMessageId,
      CURRENT_SCENE_MESSAGE_LIMIT,
    );
    const recent = recentWindow.slice(-RECENT_MESSAGE_LIMIT);
    const currentSceneSnapshot = buildCurrentSceneSnapshot(
      input.directive,
      currentWorld.location,
      recentWindow,
    );
    const retrievalQuery = [
      input.directive,
      currentWorld.time,
      currentWorld.location,
      ...recent.slice(-8).flatMap(item => [item.title, item.content.slice(0, 1800)]),
    ].join('\n');
    const worldbookCandidates = mapSources(worldbook, 'worldbook', 100);
    const characterCandidates = mapSources(characters, 'mvu', 95);
    const genealogyCandidates = mapSources(genealogy, 'genealogy', 75);
    const biographyCandidates = mapSources(biographies.map(source => ({
      ...source,
      content: digestBiographySource(source.content),
    })), 'biography', 70);
    const butterflyCandidates = mapSources(butterflies, 'butterfly', 70);
    const worldbookContext = selectRelevantContextSources(
      worldbookCandidates,
      retrievalQuery,
      { limit: 12, contentLimit: 3000, fallbackCount: 4 },
    );
    const recentContext = mapSources(recent, 'chat', 80);
    const characterContext = selectRelevantContextSources(
      characterCandidates, retrievalQuery,
      { limit: 8, contentLimit: 3500, fallbackCount: 2 },
    );
    const genealogyContext = selectRelevantContextSources(
      genealogyCandidates, retrievalQuery,
      { limit: 6, contentLimit: 3600, fallbackCount: 0 },
    );
    // 旧传记只注入结构化摘要（对象/跨度/总述/各段开头），不再携带全文正文。
    const biographyRefs = selectRelevantContextSources(
      biographyCandidates, retrievalQuery,
      { limit: 6, contentLimit: 4200, fallbackCount: 0 },
    );
    const butterflyRefs = selectRelevantContextSources(
      butterflyCandidates, retrievalQuery,
      { limit: 5, contentLimit: 3200, fallbackCount: 0 },
    );
    const legacySourceIndex = [
      ...worldbookContext,
      ...characterContext,
      ...recentContext,
      ...genealogyContext,
      ...biographyRefs,
      ...butterflyRefs,
    ];
    const canonBranch = await this.canonRepository?.getBranch(input.namespace);
    const active = await resolveActiveRetrieval({
      retrieval: this.retrievalShadow,
      requestId: input.requestId,
      taskType: 'biography',
      query: input.directive,
      contextQuery: [
        currentWorld.time,
        currentWorld.location,
        ...recent.slice(-8).flatMap(item => [item.title, item.content.slice(0, 1800)]),
      ].join('\n'),
      runtimeCandidates: [
        ...worldbook.map(source => ({ ...source, sourceType: 'worldbook' as const })),
        ...characterCandidates,
        ...recentContext,
        ...genealogyCandidates,
        ...biographyCandidates,
        ...butterflyCandidates,
      ],
      contextCandidates: [
        ...worldbookCandidates,
        ...characterCandidates,
        ...recentContext,
        ...genealogyCandidates,
        ...biographyCandidates,
        ...butterflyCandidates,
      ],
      legacySourceIds: legacySourceIndex.map(source => source.sourceId),
      worldbookCorpusReceipt: worldbookCorpus.receipt,
      baselineWorldTime: this.ensureBaselineTime?.(input.namespace, currentWorld.time) ?? null,
      canonBranch,
    });
    const sourceIndex = active.sourceIndex;
    const continuityView = await this.continuityView(
      input.namespace,
      canonBranch,
      active.bundle.canonResolvedView,
      retrievalQuery,
      input.directive,
      currentWorld.time,
      currentWorld.location,
    );
    const activeWorldbookContext = sourceIndex.filter(source => source.sourceType === 'worldbook');
    const activeRecentContext = sourceIndex.filter(source => source.sourceType === 'chat');
    const activeCharacterContext = sourceIndex.filter(source => source.sourceType === 'mvu');
    const activeGenealogyContext = sourceIndex.filter(source => source.sourceType === 'genealogy');
    const activeBiographyRefs = sourceIndex.filter(source => source.sourceType === 'biography');
    const activeButterflyRefs = sourceIndex.filter(source => source.sourceType === 'butterfly');
    const warnings: string[] = [];
    if (activeWorldbookContext.length === 0) warnings.push('worldbook_context_empty');
    if (activeCharacterContext.length === 0) warnings.push('character_context_empty');
    if (sourceIndex.length === 0) warnings.push('active_retrieval_empty');

    return {
      schema: 'eyon.context.v1',
      taskType: 'biography',
      requestId: input.requestId,
      scope: {
        ...input.namespace,
        triggerMessageId: input.triggerMessageId,
      },
      currentWorld,
      ...(currentSceneSnapshot ? { currentSceneSnapshot } : {}),
      worldbookContext: activeWorldbookContext,
      recentContext: activeRecentContext,
      characterContext: activeCharacterContext,
      genealogyContext: activeGenealogyContext,
      biographyRefs: activeBiographyRefs,
      butterflyRefs: activeButterflyRefs,
      sourceIndex,
      evidenceBundle: active.bundle,
      ...(continuityView ? { continuityView } : {}),
      warnings,
      sourceHash: await hashSources(
        input.directive,
        currentWorld,
        sourceIndex,
        active.bundle,
        currentSceneSnapshot,
        continuityView,
      ),
    };
  }

  private async continuityView(
    namespace: { characterKey: string; chatId: string },
    branch: CanonBranch | undefined,
    canonView: CanonResolvedView | undefined,
    query: string,
    subject: string,
    time: string,
    location: string,
  ): Promise<ContinuityView | undefined> {
    if (!this.biographyRepository || !branch || !canonView) return undefined;
    try {
      return buildContinuityViewSafely({
        records: await this.biographyRepository.list(namespace),
        branchId: branch.branchId,
        canonRevision: canonView.resolvedRevision,
        query,
        targetView: canonView,
        branch,
        cacheScope: {
          namespace: namespaceKey(namespace),
          module: 'biography',
          subjectScope: [subject],
          timeScope: [time],
          locationScope: [location],
        },
      });
    } catch (error) {
      console.warn('[Eyon History Workbench] continuity view unavailable; continuing biography without it', error);
      return undefined;
    }
  }

  private buildRecentSources(triggerMessageId: number, limit = RECENT_MESSAGE_LIMIT) {
    const end = Math.min(triggerMessageId, this.runtime.getLastMessageId());
    if (end < 0) return [];
    const start = Math.max(0, end - limit + 1);
    return this.runtime
      .getChatMessages(`${start}-${end}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim())
      .map(message => ({
        sourceId: `chat:${message.message_id}`,
        title: `${message.role} floor ${message.message_id}`,
        content: message.message.slice(0, RECENT_CONTENT_LIMIT),
      }));
  }
}

/**
 * 已提交传记以结构化 JSON 全文进入上下文时体积巨大（每篇可达上万字符）。
 * 只保留可锚定的摘要：对象、跨度、总述、每段首尾与结构化实体。
 * 首尾同时保留，避免只截开头而丢失事件结果、人物关系与阶段衔接。
 * v2.1（internal.76 收尾 B）：追加「事件时间线」——从原文明确纪年提取
 * {绝对年 → X纪元N年事件句}，按时间排序；未记载年份的事件不出行（不猜）。
 */
export function digestBiographySource(content: string): string {
  try {
    const record = JSON.parse(content) as {
      target?: { name?: unknown; aliases?: unknown };
      span?: { label?: unknown };
      summary?: unknown;
      origin?: { title?: unknown; content?: unknown };
      stages?: Array<{
        title?: unknown;
        span?: unknown;
        content?: unknown;
        people?: unknown;
        factions?: unknown;
        objects?: unknown;
        locations?: unknown;
        inference?: unknown;
      }>;
      status?: { title?: unknown; content?: unknown };
    };
    if (!record || typeof record !== 'object') return content.slice(0, 1500);
    return JSON.stringify({
      schema: 'eyon.biography.digest.v2.2',
      target: {
        name: textOf(record.target?.name),
        aliases: textListOf(record.target?.aliases),
      },
      span: textOf(record.span?.label),
      summary: textOf(record.summary),
      timeline: extractBiographyTimeline(content),
      objectBands: extractObjectBands(content),
      origin: passageDigest(record.origin),
      stages: (record.stages ?? []).map(stage => ({
        title: textOf(stage.title),
        span: textOf(stage.span),
        content: continuityExcerpt(textOf(stage.content), 180, 220),
        people: textListOf(stage.people),
        factions: textListOf(stage.factions),
        objects: textListOf(stage.objects),
        locations: textListOf(stage.locations),
        inference: stage.inference === true,
      })),
      status: passageDigest(record.status),
    });
  } catch {
    return content.slice(0, 1500);
  }
}

/**
 * 物件时间带 + 语境摘录（internal.77 三轮覆盖）：
 * ① 各段物件与该段跨度绑定输出显式行（时段归属）；
 * ② 每个物件附带**当前段原文语境**（在该段 prose 中按物件名提取 ≤72 字，
 *    原样摘录、不解释语义）——模型因此看到「环=冰冷、扣在高领下」之类语境，
 *    而非一个可随意搬动的名字（真机病历：玲山把圣纹压制环「赠送」妹妹，
 *    与传记 476 扣环、488 仍在戴矛盾）；
 * ③ 同名物件可在后续段再次出现，因而能保留「获得 → 损坏 → 封存」之类状态转移；
 * ④ 现状段若仍提及该物件，追加「现状（延续）」语境行——「480 送人 vs 488 还在戴」
 *    的冲突放在模型眼前。
 * 纯确定性、不猜年份、不推断语义；无物件或原文无语境则保持纯名单。
 */
export function extractObjectBands(content: string): string[] {
  try {
    const record = JSON.parse(content) as {
      origin?: { title?: unknown; span?: unknown; content?: unknown; objects?: unknown };
      stages?: Array<{ span?: unknown; content?: unknown; objects?: unknown }>;
      status?: { content?: unknown; objects?: unknown };
    };
    if (!record || typeof record !== 'object') return [];
    const contextOf = (prose: string, name: string): string => {
      const index = prose.indexOf(name);
      if (index < 0) return '';
      const from = Math.max(0, index - 26);
      return prose.slice(from, index + name.length + 46).replace(/\s+/gu, ' ').trim();
    };
    const bands: string[] = [];
    const appeared = new Set<string>();
    const segments = [
      ...(record.origin ? [{
        span: textOf(record.origin.span) || textOf(record.origin.title) || '起源',
        content: record.origin.content,
        objects: record.origin.objects,
      }] : []),
      ...(record.stages ?? []),
    ];
    for (const stage of segments) {
      const objects = textListOf(stage.objects);
      if (objects.length === 0) continue;
      const span = textOf(stage.span);
      const prose = textOf(stage.content);
      const lines: string[] = [];
      for (const object of new Set(objects)) {
        appeared.add(object);
        // 只从当前段取上下文。同名物件在后段损坏、转交或封存时，后来的状态不能
        // 被全篇第一次出现的位置覆盖。
        const context = contextOf(prose, object);
        lines.push(context ? `${object}（原文：「${context}」）` : object);
      }
      if (lines.length > 0) bands.push(`${span || '（时段未标）'}：${lines.join('；')}`);
    }
    const statusText = textOf(record.status?.content);
    const statusLines: string[] = [];
    const statusObjects = new Set([...appeared, ...textListOf(record.status?.objects)]);
    for (const object of statusObjects) {
      if (!statusText.includes(object)) continue;
      const context = contextOf(statusText, object);
      statusLines.push(`${object}（现状原文：「${context}」）`);
    }
    if (statusLines.length > 0) bands.push(`现状（延续）：${statusLines.join('；')}`);
    return bands;
  } catch {
    return [];
  }
}

/**
 * 从传记原文提取事件时间线（internal.76 收尾 B）：
 * 匹配「X纪元（前）N年，事件句」→ 按绝对年排序去重；无明确纪年不出行。
 * N 支持阿拉伯数字与中文数字（internal.77 覆盖：中文纪年是最常见写法，
 * 「复兴纪元四七六年」此前一个都提取不到 → 时间线为空 → 时间不错位失守）。
 */
export function extractBiographyTimeline(content: string): string[] {
  const byAbsoluteYear = new Map<number, string>();
  const pattern = /(创世纪元|神明纪元|混乱纪元|英雄纪元|复兴纪元)(前)?\s*([0-9零〇一二两三四五六七八九十百千]+)\s*年[^。；;\n]{3,70}/gu;
  for (const match of content.matchAll(pattern)) {
    const era = match[1];
    const yearText = match[3];
    const arabic = chineseYearToNumber(yearText);
    if (arabic === null || !Number.isFinite(arabic)) continue;
    const year = arabic * (match[2] ? -1 : 1);
    const abs = absoluteYear(era, year);
    if (abs === null) continue;
    if (!byAbsoluteYear.has(abs)) {
      byAbsoluteYear.set(abs, match[0].replace(/\s+/gu, ' ').trim());
    }
  }
  return [...byAbsoluteYear.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, line]) => line);
}

/**
 * 中文/阿拉伯数字年份 → 阿拉伯数（确定性转换，不推断）：
 * 纯位数字流「四七六」→ 476、「一〇八」→ 108；带位权「四百七十六」→ 476、「十二」→ 12。
 */
export function chineseYearToNumber(value: string): number | null {
  if (/^[0-9]+$/.test(value)) return Number(value) || null;
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (!/[十百千]/.test(value)) {
    // 纯位数字流（四七六 / 一〇八 / 一二三）：逐位拼接。
    let out = 0;
    for (const ch of value) {
      const digit = digits[ch];
      if (digit === undefined) return null;
      out = out * 10 + digit;
    }
    return out > 0 ? out : null;
  }
  // 带位权（四百七十六 / 十二 / 千零一夜）。
  let total = 0;
  let num = 0;
  for (const ch of value) {
    if (ch in digits) {
      num = digits[ch];
    } else if (ch === '十') {
      total += (num === 0 ? 1 : num) * 10;
      num = 0;
    } else if (ch === '百') {
      total += (num === 0 ? 1 : num) * 100;
      num = 0;
    } else if (ch === '千') {
      total += (num === 0 ? 1 : num) * 1000;
      num = 0;
    } else {
      return null;
    }
  }
  const result = total + num;
  return result > 0 ? result : null;
}

/**
 * 选中传记的全文参考（internal.76 收尾 B）：墟境「引用传记」强制入选时使用——
 * 原文（上限 8000 字，超出截断并标注）+ 事件时间线尾注。
 * 让模型看到「连续生平 + 明确纪年事件」，人物与时间不错位有据可依。
 */
export function biographyFullReference(content: string, limit = 8000): string {
  const timeline = extractBiographyTimeline(content);
  const objectBands = extractObjectBands(content);
  const body = content.length > limit
    ? `${content.slice(0, limit)}…（传记全文过长，截断至 ${limit} 字）`
    : content;
  const sections: string[] = [body];
  if (objectBands.length > 0) {
    sections.push(`【物件时间带】（物件归属时段来自传记各段跨度；可跨段持续存在，首次出现不得晚于该段）\n${objectBands.map(line => `- ${line}`).join('\n')}`);
  }
  if (timeline.length > 0) {
    sections.push(`【事件时间线】（按时间顺序提取自传记原文明确纪年；未记载年份的事件不在此列）\n${timeline.map(line => `- ${line}`).join('\n')}`);
  }
  return sections.join('\n\n');
}

function passageDigest(
  passage: { title?: unknown; content?: unknown } | undefined,
): { title: string; content: string } {
  return {
    title: textOf(passage?.title),
    content: continuityExcerpt(textOf(passage?.content), 220, 260),
  };
}

function continuityExcerpt(content: string, head: number, tail: number): string {
  if (content.length <= head + tail) return content;
  return `${content.slice(0, head)}…${content.slice(-tail)}`;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textListOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function mapSources(
  sources: Array<{ sourceId: string; title: string; content: string; keywords?: string[] }>,
  sourceType: ContextSource['sourceType'],
  authority: number,
): ContextSource[] {
  const seen = new Set<string>();
  return sources.flatMap(source => {
    const sourceId = source.sourceId.trim();
    const content = source.content.trim().slice(0, CONTENT_LIMIT);
    if (!sourceId || !content || seen.has(sourceId)) return [];
    seen.add(sourceId);
    return [{
      sourceId,
      sourceType,
      title: source.title.trim() || sourceId,
      content,
      authority,
      keywords: source.keywords,
    }];
  });
}

async function hashSources(
  directive: string,
  currentWorld: { time: string; location: string },
  sources: ContextSource[],
  evidenceBundle: EvidenceBundle,
  currentSceneSnapshot?: CurrentSceneSnapshot | null,
  continuityView?: ContinuityView,
): Promise<string> {
  const input = JSON.stringify({
    directive,
    currentWorld,
    currentSceneSnapshot: currentSceneSnapshot
      ? [
          currentSceneSnapshot.location,
          ...currentSceneSnapshot.evidence.map(item => [item.sourceId, item.content]),
        ]
      : null,
    sources: sources.map(source => [
      source.sourceId,
      source.sourceType,
      source.content,
    ]),
    passageStrategyVersion: evidenceBundle.receipt.passageBudget.strategyVersion,
    passages: evidenceBundle.passages.map(passage => [
      passage.passageId,
      passage.contentHash,
    ]),
    personFactIds: evidenceBundle.personCanonViews?.flatMap(view => view.relevantFactIds) ?? [],
    taskAnchorAttachments: evidenceBundle.taskAnchorAttachments?.map(attachment => [
      attachment.attachmentId,
      attachment.contentHash,
    ]) ?? [],
    canonView: evidenceBundle.canonResolvedView
      ? [
          evidenceBundle.canonResolvedView.viewId,
          evidenceBundle.canonResolvedView.branchId,
          evidenceBundle.canonResolvedView.resolvedRevision,
          evidenceBundle.canonResolvedView.queryScopeHash,
        ]
      : null,
    continuityView: continuityView
      ? [
          continuityView.branchId,
          continuityView.canonRevision,
          continuityView.queryScopeHash,
          ...continuityView.anchors.map(anchor => [anchor.handle, anchor.claim]),
          ...continuityView.relationGroups.map(group => [
            group.kind, group.dimension, ...group.handles, group.omittedMemberCount,
          ]),
        ]
      : null,
  });
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
