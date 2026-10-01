import {
  WORLD_KNOWLEDGE_CATALOG_SCHEMA,
  type EvidenceClaim,
  type KnowledgeCatalogCoverage,
  type KnowledgeEntity,
  type KnowledgeEntityKind,
  type KnowledgeRelation,
  type KnowledgeSpan,
  type SourceSnapshot,
  type WorldKnowledgeCatalog,
} from './contracts.ts';
import {
  buildCharacterCanonFacts,
  lifeAnchorsFromCharacterFacts,
} from './characterFacts.ts';
import { buildTemporalEligibilityLedger, parseWorldTime } from './temporal.ts';
import { GenealogyIdentitySchema } from '../schemas/genealogy.ts';
import { characterDocumentOwner, templateIndependentText } from './sourceOwnership.ts';

interface EntitySeed {
  name: string;
  aliases?: string[];
  kind: KnowledgeEntityKind;
  tags?: string[];
  identity?: string;
  location?: string;
  temporal?: string;
  snapshot: SourceSnapshot;
  span?: KnowledgeSpan;
  structured: boolean;
  /** 人物时间资格（年龄/生卒）——仅当名称是人物时填充。 */
  lifespan?: KnowledgeEntity['lifespan'];
}

interface RelationSeed {
  subject: string;
  predicate: string;
  object: string;
  status: 'explicit' | 'structural';
  snapshotId: string;
  span?: KnowledgeSpan;
}

const FIELD_NAMES = new Set([
  '基本信息', '基本资料', '姓名', '名称', '性别', '年龄', '外貌', '性格',
  '身份', '职务', '别名', '又称', '旧称', '背景', '简介', '能力', '关系',
  '时间', '内容', '备注', '活动地点', '活跃于', '地点', '位置', '所在地',
  '所属', '所属组织', '所属势力', '归属', '家族', '神系',
]);

const GENERIC_TITLES = new Set([
  '世界主设定', '世界设定', '主设定', '人物', '地点', '组织', '历史', '资料', '设定',
]);

export function buildWorldKnowledgeCatalog(
  snapshots: SourceSnapshot[],
  claims: EvidenceClaim[],
): WorldKnowledgeCatalog {
  const started = performance.now();
  const seeds: EntitySeed[] = [];
  const relationSeeds: RelationSeed[] = [];
  const structuredBySnapshot = new Set<string>();
  const snapshotsById = new Map(snapshots.map(snapshot => [snapshot.snapshotId, snapshot]));
  for (const snapshot of snapshots) {
    const extracted = extractSnapshotSeeds(snapshot);
    seeds.push(...extracted.entities);
    relationSeeds.push(...extracted.relations);
    if (extracted.entities.some(seed => seed.structured)) {
      structuredBySnapshot.add(snapshot.snapshotId);
    }
  }
  for (const claim of claims) {
    const snapshot = claim.sourceSnapshotIds
      .map(snapshotId => snapshotsById.get(snapshotId))
      .find((item): item is SourceSnapshot => Boolean(item));
    if (!snapshot) continue;
    const sourceText = `${claim.subject}${claim.predicate}${claim.object}`;
    seeds.push(entitySeed(snapshot, claim.subject, inferKind(claim.subject, ''), true));
    seeds.push(entitySeed(snapshot, claim.object, inferKind(claim.object, ''), true));
    relationSeeds.push({
      subject: claim.subject,
      predicate: claim.predicate,
      object: claim.object,
      status: 'explicit',
      snapshotId: snapshot.snapshotId,
      span: locateSpan(snapshot, sourceText) ?? locateSpan(snapshot, claim.subject) ?? undefined,
    });
    structuredBySnapshot.add(snapshot.snapshotId);
  }

  const entities = mergeSeeds(seeds);
  // P0-A：先建立可追踪的人物事实，再把事件事实投影为旧 lifeAnchors 兼容视图。
  for (const entity of entities) {
    if (!entity.kinds.includes('person')) continue;
    const characterFacts = buildCharacterCanonFacts(entity, snapshotsById);
    if (characterFacts.facts.length > 0) entity.characterFacts = characterFacts;
    const anchors = lifeAnchorsFromCharacterFacts(characterFacts);
    if (anchors.length > 0) entity.lifeAnchors = anchors;
  }
  const aliases = aliasIndex(entities);
  const relations = materializeRelations(relationSeeds, aliases);
  const temporalEligibility = buildTemporalEligibilityLedger(snapshots, entities, relations);
  const adjacency = relationAdjacency(relations, 'forward');
  const reverseAdjacency = relationAdjacency(relations, 'reverse');
  const coverage: KnowledgeCatalogCoverage[] = snapshots.map(snapshot => {
    const entityIds = entities
      .filter(entity => entity.sourceSnapshotIds.includes(snapshot.snapshotId))
      .map(entity => entity.entityId);
    const status = structuredBySnapshot.has(snapshot.snapshotId)
      ? 'indexed'
      : entityIds.length > 0 ? 'partial' : 'opaque';
    return {
      snapshotId: snapshot.snapshotId,
      status,
      entityIds,
      fullTextIndexed: true,
      reason: status === 'indexed'
        ? 'structured-entity-or-relation'
        : status === 'partial' ? 'title-and-fulltext-fallback' : 'fulltext-only-fallback',
    };
  });
  return {
    schema: WORLD_KNOWLEDGE_CATALOG_SCHEMA,
    entities,
    relations,
    adjacency,
    reverseAdjacency,
    coverage,
    temporalEligibility,
    buildDurationMs: performance.now() - started,
  };
}

function extractSnapshotSeeds(snapshot: SourceSnapshot): {
  entities: EntitySeed[];
  relations: RelationSeed[];
} {
  const entities: EntitySeed[] = [];
  const relations: RelationSeed[] = [];
  const titleParts = [...snapshot.title.matchAll(/[【\[]([^】\]]+)[】\]]/gu)].map(match => match[1].trim());
  const cleanTitle = snapshot.title.replace(/[【\[][^】\]]+[】\]]/gu, '').trim();
  const taggedName = [...titleParts].reverse().find(part =>
    !/^(?:角色|人物|地点|组织|势力|家族|事件|历史|设定|世界书|神明)$/u.test(part)) ?? '';
  const taggedNameOwnsTitle = Boolean(taggedName) && (
    cleanTitle === taggedName
    || cleanTitle.startsWith(`${taggedName}(`)
    || cleanTitle.startsWith(`${taggedName}（`)
  );
  const owner = characterDocumentOwner(snapshot);
  const heading = templateIndependentText(snapshot.content).match(/^\s*#{1,6}\s+(.{2,50}?)\s*$/mu)?.[1]?.trim();
  // 同一人的习惯/背景补充不能被标题误造为另一个人；但其经营的商会仍是独立实体。
  const separateTopic = Boolean(owner && heading && heading !== owner && cleanTitle === heading);
  const titleName = separateTopic ? heading! : owner || (taggedNameOwnsTitle ? taggedName : cleanTitle || taggedName);
  const explicitKind = separateTopic
    ? (/^\s*(?:总部|势力标识)\s*[:：]/mu.test(snapshot.content) ? 'organization' : null)
    : explicitTitleKind(titleParts);
  // MVU 源（stat_data.关系列表）条目天然是人物：标题就是角色名（通常无「[角色]」标签），
  // 不能因名字里没有类型线索就判 unknown——否则年龄/生卒提取（仅 person 类型）会整链失效。
  // 只有人物资料自己的字段才能成为“记录时年龄”。传记、蝴蝶日志与聊天正文中的
  // “某年，十九岁的某人……”描述的是事件现场，绝不能反过来把来源标题认成人物，
  // 更不能拿当前世界时间减去该事件年龄去伪造出生年。
  const lifespanAnywhere = extractLifespanAnywhere(snapshot.content);
  const lifespanCanTypeTitle = snapshot.sourceType === 'worldbook'
    && lifespanAnywhere !== undefined;
  const titleKind = snapshot.sourceType === 'mvu'
    ? 'person'
    : explicitKind ?? (lifespanCanTypeTitle ? 'person' : inferKind(titleName, titleParts.join(' ')));
  const titleTemporal = snapshot.content.match(/[\p{Script=Han}]{2,8}纪元/u)?.[0];
  if (titleName.length >= 2 && !GENERIC_TITLES.has(titleName)) {
    entities.push({
      ...entitySeed(snapshot, titleName, titleKind, titleKind !== 'unknown'),
      tags: /(?:神明|神祇|女神|男神)/u.test(titleParts.join(' ')) ? ['deity'] : [],
      temporal: titleTemporal,
    });
  }

  // 人物时间资格：只接受人物资料源中的显式生卒字段或带字段名的年龄。
  // 覆盖 MVU 源 JSON 化内容（JSON.stringify 后整条目为一行，行级解析天然失效）与
  // 世界书人物条目中非行首的「年龄: N岁」写法；自由叙事里的事件年龄不参与。
  if (titleName && titleKind === 'person' && lifespanAnywhere
    && (snapshot.sourceType === 'worldbook' || snapshot.sourceType === 'mvu')) {
    entities.push({
      ...entitySeed(snapshot, titleName, titleKind, true),
      lifespan: lifespanAnywhere,
      // 与标题种子共用时间域，避免同一条人物资料被拆成“无时代人物 + 有时代人物”。
      temporal: titleTemporal,
    });
  }

  const structured = extractStructuredSeeds(snapshot);
  entities.push(...structured.entities);
  relations.push(...structured.relations);

  let currentGroup = '';
  let offset = 0;
  for (const line of snapshot.content.split(/\r?\n/u)) {
    const lineStart = offset;
    offset += line.length + 1;
    const markdown = line.match(/^\s*#{1,6}\s+(.{2,50}?)\s*$/u);
    if (markdown) {
      const name = markdown[1].trim();
      if (!FIELD_NAMES.has(name) && !GENERIC_TITLES.has(name)) {
        currentGroup = name;
        entities.push(entitySeed(snapshot, name, inferKind(name, '群体'), true, lineStart));
      }
      continue;
    }
    // Markdown 表中的时刻冒号不是「人物名: 设定」。原表仍完整留给模型，
    // 这里只禁止把“| 进入时墟境时间 | ...09”当作具名人物。
    if (/^\s*\|/u.test(line)) continue;
    const field = line.match(/^\s*(?:[-*]\s*)?([^:：<>\[\]{}]{2,60})[:：]\s*(.*)$/u);
    if (!field) continue;
    const label = field[1].trim();
    const value = field[2].trim();
    if (hasUnresolvedBranches(snapshot.content)) continue;
    const relationField = /^(?:所属|所属组织|所属势力|归属|家族|神系|地点|位置|所在地|活动地点|活跃于)$/u.test(label);
    if (/^(?:身份|职务)$/u.test(label) && titleName && value) {
      entities.push({
        ...entitySeed(snapshot, titleName, titleKind, true),
        identity: value,
        temporal: titleTemporal,
      });
    }
    if (/^(?:别名|又称|旧称)$/u.test(label) && titleName && value) {
      entities.push({
        ...entitySeed(snapshot, titleName, titleKind, true),
        aliases: value.split(/[、，,/]/u).map(item => item.trim()).filter(Boolean),
        temporal: titleTemporal,
      });
    }
    // 人物时间资格：显式生卒年（「复兴纪元400年 - 复兴纪元479年」）或当前年龄（「年龄: 88岁」）。
    // 年龄换算的基准年由运行时 baselineWorldTime 提供（resolveLifespanFromBaseline），
    // 这里只提取原始事实（ageAtRecord / 显式 born/died），不在此做换算。
    if (titleName && titleKind === 'person' && !hasUnresolvedBranches(snapshot.content)) {
      const explicit = /^(?:生卒(?:年)?|寿命|出生(?:时间|日期|年份)?|诞生)$/u.test(label)
        ? extractExplicitLifespan(value) : undefined;
      if (explicit) {
        entities.push({
          ...entitySeed(snapshot, titleName, titleKind, true),
          lifespan: explicit,
          temporal: titleTemporal,
        });
      } else if (/^年龄$/u.test(label)) {
        const age = extractRecordedAge(value);
        if (age !== undefined) {
          const arrivalBased = /界外来客|来自异界|穿越|异乡|书页.*门|另一.*世界|地球/u.test(
            snapshot.content,
          );
          entities.push({
            ...entitySeed(snapshot, titleName, titleKind, true),
            lifespan: {
              ageAtRecord: age,
              ...recordedAgeBaseline(value),
              ...(arrivalBased ? { arrivalBased: true } : {}),
            },
            temporal: titleTemporal,
          });
        }
      }
    }
    if (FIELD_NAMES.has(label) && !relationField) continue;
    const middleName = label.split(/[・·]/u).slice(1).join('・')
      .replace(/[（(].*$/u, '').trim();
    const canonical = middleName.length >= 2 ? middleName : label;
    const deityDefinition = !value && /^(?:神明|圣灵)(?:\s|$|[（(])/u.test(currentGroup);
    const kind = inferKind(canonical, deityDefinition ? `${label} 神明人物` : label);
    if (!relationField && canonical.length >= 2 && canonical.length <= 40) {
      const tags = deityDefinition || /(?:女神|男神|神祇|神明|圣灵)/u.test(label)
        ? ['deity'] : [];
      const aliases = [...label.matchAll(/[（(]([^）)]+)[）)]/gu)]
        .flatMap(match => {
          const inner = match[1].trim();
          // 结构字段净化：括号内是「类别/品质」等属性标注时不是别名，不拆。
          // ① 含斜杠分隔（如「物品/史诗」「被动/史诗」）——类别/品质双字段；
          // ② 去掉空格后为 1-2 字且无分隔的单字段品质标注（如「(史诗)」「(稀有)」）。
          // 否则「月桂源生匣(物品/史诗)」「锻造匠师 (史诗)」会把「史诗」拆成实体别名，
          // 经 buildEventFrame 的 query.includes(别名) 匹配让「英雄史诗」污染装备/品质条目。
          if (inner.includes('/') || inner.includes('／')) return [];
          if (inner.replace(/\s+/gu, '').length <= 2 && !/[，,、]/u.test(inner)) return [];
          return inner.split(/[、，,/]/u).map(item => item.trim()).filter(Boolean);
        });
      entities.push({
        ...entitySeed(snapshot, canonical, kind, true, lineStart),
        aliases,
        tags,
        identity: label === canonical ? undefined : label,
      });
      if (currentGroup && currentGroup !== canonical) {
        relations.push({
          subject: canonical,
          predicate: 'member_of',
          object: currentGroup,
          status: 'structural',
          snapshotId: snapshot.snapshotId,
          span: { snapshotId: snapshot.snapshotId, startOffset: lineStart, endOffset: lineStart + line.length },
        });
      }
    }
    if (/^(?:所属|所属组织|所属势力|归属|家族|神系)$/u.test(label) && titleName && value) {
      entities.push(entitySeed(snapshot, value, inferKind(value, label), true));
      relations.push({ subject: titleName, predicate: 'belongs_to', object: value, status: 'explicit', snapshotId: snapshot.snapshotId });
    }
    if (/^(?:地点|位置|所在地|活动地点|活跃于)$/u.test(label) && titleName && value) {
      const places = value.split(/\s*(?:—|->|>|\/|\\)\s*/u).map(item => item.trim()).filter(Boolean);
      for (const place of places) entities.push(entitySeed(snapshot, place, 'place', true));
      if (places.length) relations.push({ subject: titleName, predicate: 'active_in', object: places.at(-1)!, status: 'explicit', snapshotId: snapshot.snapshotId });
      for (let index = 1; index < places.length; index += 1) {
        relations.push({ subject: places[index], predicate: 'located_in', object: places[index - 1], status: 'structural', snapshotId: snapshot.snapshotId });
      }
    }
  }
  for (const seed of explicitSentenceRelations(snapshot)) {
    relations.push(seed);
    entities.push(entitySeed(snapshot, seed.subject, relationKind(seed.predicate, 'subject'), true));
    entities.push(entitySeed(snapshot, seed.object, relationKind(seed.predicate, 'object'), true));
  }
  return { entities, relations };
}

function explicitTitleKind(parts: readonly string[]): KnowledgeEntityKind | null {
  const tags: ReadonlyArray<readonly [RegExp, KnowledgeEntityKind]> = [
    [/^(?:角色|人物|神明)$/u, 'person'],
    [/^地点$/u, 'place'],
    [/^(?:组织|机构)$/u, 'organization'],
    [/^势力$/u, 'faction'],
    [/^(?:家族|宗族)$/u, 'family'],
    [/^(?:事件|历史)$/u, 'event'],
  ];
  for (const part of parts) {
    for (const [pattern, kind] of tags) if (pattern.test(part)) return kind;
  }
  return null;
}

function extractStructuredSeeds(snapshot: SourceSnapshot): {
  entities: EntitySeed[];
  relations: RelationSeed[];
} {
  let root: unknown;
  try {
    root = JSON.parse(snapshot.content);
  } catch {
    return { entities: [], relations: [] };
  }
  const entities: EntitySeed[] = [];
  const relations: RelationSeed[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    const name = firstString(value, ['name', '姓名', '名称', 'title', 'focusCharacterName']);
    if (name) {
      const type = firstString(value, ['kind', 'type', '类型', 'category']);
      const aliases = stringValues(value.aliases ?? value['别名'] ?? value['又称']);
      const identity = firstString(value, ['identity', '身份', 'role', '职务', 'profession'])
        || stringValues(value.identities).join('、')
        || stringValues(value.professions).join('、');
      const temporal = firstString(value, ['era', 'time', '时期', '纪元']);
      const location = firstString(value, ['location', '地点', '所在地', 'activeAt']);
      // 谱系节点本身已经保存结构化生卒。它与世界书/MVU 是同一人物时间事实的
      // 不同来源，必须进入同一 lifespan → personTimeline 通路，不能让自动召回的
      // 亲属只剩姓名、却丢失年龄与生命阶段。
      const genealogyLifespan = structuredGenealogyLifespan(value);
      const kind = genealogyLifespan ? 'person' : inferKind(name, type);
      entities.push({
        ...entitySeed(snapshot, name, kind, true),
        aliases,
        tags: /(?:神明|神祇|女神|男神)/u.test(`${type}${identity}`) ? ['deity'] : [],
        identity: identity || undefined,
        temporal: temporal || undefined,
        location: location || undefined,
        lifespan: genealogyLifespan,
      });
      for (const [keys, predicate] of [
        [['所属', '所属组织', '所属势力', 'organization', 'faction'], 'belongs_to'],
        [['地点', '所在地', 'location', 'activeAt'], 'active_in'],
        [['父亲', '母亲', 'parent'], 'parent'],
        [['配偶', 'spouse'], 'spouse'],
        [['participatedIn', '参与事件'], 'participated_in'],
      ] as const) {
        for (const object of keys.flatMap(key => stringValues(value[key]))) {
          entities.push(entitySeed(snapshot, object, relationKind(predicate, 'object'), true));
          relations.push({ subject: name, predicate, object, status: 'explicit', snapshotId: snapshot.snapshotId });
        }
      }
    }
    for (const item of Object.values(value)) visit(item);
  };
  visit(root);
  return { entities, relations };
}

function structuredGenealogyLifespan(
  value: Record<string, unknown>,
): KnowledgeEntity['lifespan'] | undefined {
  const parsedIdentity = GenealogyIdentitySchema.safeParse(value.identity);
  if (parsedIdentity.success && !['native', 'adoption'].includes(parsedIdentity.data.lineageKind)) {
    const identity = parsedIdentity.data;
    const originKind = identity.lineageKind === 'creation' ? 'activation'
      : ['possession', 'reincarnation'].includes(identity.lineageKind) ? 'incarnation' : 'arrival';
    const born = structuredGenealogyLifePoint(identity[originKind]);
    const died = structuredGenealogyLifePoint(identity.identityEnd);
    return { originKind, identityTracks: identity, ...(born ? { born } : {}), ...(died ? { died } : {}) };
  }
  const birth = structuredGenealogyLifePoint(value.birth);
  if (!birth) return undefined;
  const death = isRecord(value.death) ? value.death : null;
  const deathStatus = death && typeof death.status === 'string'
    ? death.status.trim().toLocaleLowerCase('en-US')
    : '';
  const died = deathStatus === 'alive'
    ? null
    : structuredGenealogyLifePoint(death);
  return died === undefined ? { born: birth } : { born: birth, died };
}

function structuredGenealogyLifePoint(
  value: unknown,
): { era: string; year: number } | undefined {
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === 'string'
    ? value.status.trim().toLocaleLowerCase('en-US')
    : '';
  if (status === 'unknown' || status === 'alive') return undefined;
  const era = typeof value.era === 'string' ? value.era.trim() : '';
  const year = typeof value.year === 'number' && Number.isInteger(value.year)
    ? value.year
    : null;
  return era && year !== null ? { era, year } : undefined;
}

function explicitSentenceRelations(snapshot: SourceSnapshot): RelationSeed[] {
  const patterns: Array<{ pattern: RegExp; predicate: string }> = [
    { pattern: /^(.{2,30}?)(?:是|作为)(.{2,30}?)(?:的)?成员$/u, predicate: 'member_of' },
    { pattern: /^(.{2,30}?)(?:属于|隶属于|归属于|效忠于)(.{2,30})$/u, predicate: 'belongs_to' },
    { pattern: /^(.{2,30}?)位于(.{2,30})$/u, predicate: 'located_in' },
    { pattern: /^(.{2,30}?)(?:活跃于|活动于|常驻于)(.{2,30})$/u, predicate: 'active_in' },
    { pattern: /^(.{2,30}?)(?:统治|管辖)(.{2,30})$/u, predicate: 'rules' },
    { pattern: /^(.{2,30}?)(?:负责|守护)(.{2,30})$/u, predicate: 'responsible_for' },
    { pattern: /^(.{2,30}?)(?:参与|参加)(?:了)?(.{2,30})$/u, predicate: 'participated_in' },
    { pattern: /^(.{2,30}?)(?:发生于|发生在)(.{2,30})$/u, predicate: 'occurred_in' },
    { pattern: /^(.{2,30}?)(?:导致|造成|引发)(.{2,30})$/u, predicate: 'caused' },
  ];
  const output: RelationSeed[] = [];
  for (const raw of snapshot.content.split(/[。；;\n]/u)) {
    const sentence = raw.trim();
    if (!sentence || /(?:不属于|不隶属|并非|未曾|没有)/u.test(sentence)) continue;
    for (const { pattern, predicate } of patterns) {
      const match = sentence.match(pattern);
      if (!match || !validRelationName(match[1]) || !validRelationName(match[2])) continue;
      output.push({
        subject: match[1].trim(),
        predicate,
        object: match[2].trim(),
        status: 'explicit',
        snapshotId: snapshot.snapshotId,
        span: locateSpan(snapshot, sentence) ?? undefined,
      });
      break;
    }
  }
  return output;
}

function entitySeed(
  snapshot: SourceSnapshot,
  name: string,
  kind: KnowledgeEntityKind,
  structured: boolean,
  startOffset?: number,
): EntitySeed {
  const trimmed = name.trim().replace(/[。；;，,]+$/u, '');
  return {
    name: trimmed,
    kind,
    snapshot,
    structured,
    span: startOffset === undefined
      ? locateSpan(snapshot, trimmed) ?? undefined
      : { snapshotId: snapshot.snapshotId, startOffset, endOffset: startOffset + trimmed.length },
  };
}

/**
 * 人物时间资格的「任意位置」提取：在全文（含 JSON 化/单行内容）中定位显式生卒
 * 与「年龄: N岁」。行级解析覆盖不到的场景（MVU 源 JSON.stringify 后的单行条目、
 * 非行首的年龄字段）由这里兜底。显式生卒优先，年龄其次（与行级口径一致）。
 */
function extractLifespanAnywhere(content: string): KnowledgeEntity['lifespan'] | undefined {
  content = templateIndependentText(content);
  // 只在明确的人物生卒字段中解释日期；正文中的历史事件日期绝不能冒充出生年。
  const explicitWindow = content.match(
    /(?:^|[\n\r,{，]|\\n)\s*["']?(?:生卒(?:年)?|寿命|出生(?:时间|日期|年份)?|诞生|生日)["']?\s*[:：]\s*["']?([^"'\n\r,，}]{1,120})/u,
  )?.[1];
  const explicit = explicitWindow ? extractExplicitLifespan(explicitWindow) : undefined;
  if (explicit) return explicit;
  // 年龄只能来自字段形态（Markdown/YAML 的「年龄：」或 MVU JSON 的
  // `"年龄":"..."`），不扫描自由叙事中的裸「N岁」。裸年龄仍可由公开
  // extractRecordedAge() 在明确字段值上调用，但不再作为全文兜底。
  const ageField = content.match(
    /(?:^|[\n\r,{，]|\\n)\s*["']?(?:实际年龄|实龄|年龄)["']?\s*[:：]\s*["']?([^"'\n\r,，}]{1,80})/u,
  )?.[1];
  // 只在人物介绍类字段内接受明确“实龄/实际年龄”；不扫描背景中的事件年龄。
  const description = content.match(
    /(?:^|[\n\r,{，]|\\n)\s*["']?(?:外貌|外观|介绍|简介)["']?\s*[:：]\s*["']?([^"'\n\r}]{1,180})/u,
  )?.[1];
  const actualAge = description?.match(/(?:实际(?:年龄)?|实龄)\s*[:：]?\s*\d+\s*岁/u)?.[0];
  const age = ageField ? extractRecordedAge(ageField) : actualAge ? extractRecordedAge(description!) : undefined;
  if (age !== undefined) {
    const arrivalBased = /界外来客|来自异界|穿越|异乡|书页.*门|另一.*世界|地球/u.test(content);
    return {
      ageAtRecord: age,
      ...recordedAgeBaseline(ageField ?? description!),
      ...(arrivalBased ? { arrivalBased: true } : {}),
    };
  }
  return undefined;
}

/** 只有年龄字段自身明确标出的记录年才覆盖开局基准；不借背景事件日期。 */
function recordedAgeBaseline(value: string): Partial<NonNullable<KnowledgeEntity['lifespan']>> {
  const annotation = value.match(/[（(]\s*([^）)]+)[）)]/u)?.[1] ?? '';
  if (!/(?:记录|记载|截至|截止|年时)|^[^\d\s]{2,32}前?\s*\d+年$/u.test(annotation)) return {};
  const recorded = parseWorldTime(annotation.replace(/^(?:截至|截止|记录于|记载于)\s*/u, ''));
  return recorded.era && recorded.year !== null
    ? { basedOnEra: recorded.era, basedOnYear: recorded.year } : {};
}

/**
 * 智能年龄提取（internal.79 v7）：脚本保留但只对「机器可判格式」换算——
 * 1) 显式「实际N岁」优先（双轨人物卡取实际轨，如「外貌16岁 (实际28岁)」→ 28）；
 * 2) 剔除「外貌/心理/生理/视觉/约/大概/接近」等修饰后的普通「N岁」；
 * 3) 其余歧义描述（无实际标注的双轨、特殊年龄体系）不提取 → 年龄锚空、
 *    硬门放行（不判死），原始文本仍在人物卡全文里交给模型自行理解（不猜）。
 */
export function extractRecordedAge(text: string): number | undefined {
  const explicit = [...text.matchAll(/(?:实际(?:年龄)?|实龄)\s*[:：]?\s*(\d+)\s*岁/gu)];
  if (explicit.length === 1 && !/(?:岁\s*或|\d\s*[-~～至]\s*\d)/u.test(text)) {
    const age = Number(explicit[0]![1]);
    return Number.isSafeInteger(age) ? age : undefined;
  }
  if (explicit.length > 1 || /不详|未知|可能|或许|大约|大概|将近|接近|约|\d\s*[-~～至]\s*\d/u.test(text)) return undefined;
  const cleaned = text.replace(
    /(?:外貌|外观|心理|生理|视觉|看起来)[^\d]{0,6}\d+\s*岁/gu,
    '',
  );
  const plain = [...cleaned.matchAll(/(?<![\d.])(\d+)\s*岁/gu)];
  if (plain.length !== 1) return undefined;
  const number = Number(plain[0]![1]);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/** 原始 EJS 不执行；未求值分支只能作为原文资料，不能被拼成同一时点的硬事实。 */
export function hasUnresolvedBranches(content: string): boolean {
  return /<%[\s\S]*?\b(?:if|else|switch)\b[\s\S]*?%>/u.test(content);
}

/** 解析「复兴纪元400年 - 复兴纪元479年」/「复兴纪元400年-在世」式显式生卒。 */
function extractExplicitLifespan(value: string): KnowledgeEntity['lifespan'] | undefined {
  const parts = value.trim().split(/\s*(?:[-–—~～]|至)\s*/u);
  const first = parseWorldTime(parts[0]);
  if (!first.era || first.year === null) return undefined;
  const born = { era: first.era, year: first.year };
  const second = parseWorldTime(parts[1]);
  const died = second.era && second.year !== null
    ? { era: second.era, year: second.year }
    : /在世|存活|alive|至今/iu.test(value)
      ? null
      : undefined;
  if (died === undefined) return { born };
  return { born, died };
}

function mergeSeeds(seeds: EntitySeed[]): KnowledgeEntity[] {
  const merged = new Map<string, KnowledgeEntity>();
  for (const seed of seeds) {
    const normalized = normalize(seed.name);
    if (normalized.length < 2 || FIELD_NAMES.has(seed.name)) continue;
    const temporal = seed.temporal ?? '';
    const key = `${normalized}|${normalize(temporal)}`;
    const entity = merged.get(key) ?? {
      entityId: `entity:${encodeURIComponent(normalized)}${temporal ? `:${encodeURIComponent(normalize(temporal))}` : ''}`,
      canonicalName: seed.name,
      normalizedName: normalized,
      aliases: [],
      kinds: [],
      tags: [],
      temporalScopes: [],
      locationScopes: [],
      identities: [],
      sourceSnapshotIds: [],
      spans: [],
    };
    uniquePush(entity.kinds, seed.kind);
    for (const alias of seed.aliases ?? []) uniquePush(entity.aliases, alias);
    for (const tag of seed.tags ?? []) uniquePush(entity.tags, tag);
    if (seed.temporal) uniquePush(entity.temporalScopes, seed.temporal);
    if (seed.location) uniquePush(entity.locationScopes, seed.location);
    if (seed.identity) uniquePush(entity.identities, seed.identity);
    // 同名实体（MVU 与 worldbook 双源）合并时 lifespan 取「信息最全」者，而非先到先得——
    // 双源内容可能一个带显式生卒、一个只有年龄，先到先得会让信息少的那份覆盖/占位。
    if (seed.lifespan && (
      !entity.lifespan
      || lifespanInfoScore(seed.lifespan) > lifespanInfoScore(entity.lifespan)
    )) {
      entity.lifespan = seed.lifespan;
    }
    uniquePush(entity.sourceSnapshotIds, seed.snapshot.snapshotId);
    if (seed.span && !entity.spans.some(span => sameSpan(span, seed.span!))) entity.spans.push(seed.span);
    merged.set(key, entity);
  }
  // 无日期的习惯/补充资料不是一个“无时代分身”。仅当同名人物只有一个
  // 有日期的身份锚、且明确生卒不冲突时，将无日期片段补到该锚；跨时代
  // 同名者仍保留歧义，不凭姓名强行合并。
  const entities = [...merged.values()];
  const byName = new Map<string, KnowledgeEntity[]>();
  for (const entity of entities) {
    const group = byName.get(entity.normalizedName) ?? [];
    group.push(entity);
    byName.set(entity.normalizedName, group);
  }
  const absorbed = new Set<string>();
  for (const group of byName.values()) {
    const dated = group.filter(entity => entity.temporalScopes.length && entity.kinds.includes('person'));
    const undated = group.find(entity => !entity.temporalScopes.length
      && entity.kinds.every(kind => kind === 'person' || kind === 'unknown'));
    if (dated.length !== 1 || !undated) continue;
    const anchor = dated[0]!;
    const conflict = (['born', 'died'] as const).some(key => {
      const a = anchor.lifespan?.[key];
      const b = undated.lifespan?.[key];
      return a && b && a.year != null && b.year != null
        && (a.era !== b.era || a.year !== b.year);
    });
    if (conflict) continue;
    for (const key of ['aliases', 'kinds', 'tags', 'locationScopes', 'identities', 'sourceSnapshotIds'] as const) {
      for (const item of undated[key]) uniquePush(anchor[key] as string[], item);
    }
    for (const span of undated.spans) {
      if (!anchor.spans.some(existing => sameSpan(existing, span))) anchor.spans.push(span);
    }
    if (undated.lifespan && (!anchor.lifespan
      || lifespanInfoScore(undated.lifespan) > lifespanInfoScore(anchor.lifespan))) {
      anchor.lifespan = undated.lifespan;
    }
    absorbed.add(undated.entityId);
  }
  return entities.filter(entity => !absorbed.has(entity.entityId)).map(entity => {
    if (entity.kinds.includes('person')) entity.kinds = entity.kinds.filter(kind => kind !== 'unknown');
    return entity;
  }).sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/** lifespan 信息完整度评分：显式生卒 > 只有出生 > 只有年龄 > 无。 */
function lifespanInfoScore(lifespan: NonNullable<KnowledgeEntity['lifespan']>): number {
  if (lifespan.identityTracks) return 5;
  let score = 0;
  if (lifespan.born?.era && lifespan.born.year !== null && lifespan.born.year !== undefined) score += 2;
  if (lifespan.died?.era && lifespan.died.year !== null && lifespan.died.year !== undefined) score += 1;
  if (lifespan.ageAtRecord !== undefined) score += 1;
  return score;
}

function materializeRelations(
  seeds: RelationSeed[],
  aliases: Map<string, KnowledgeEntity[]>,
): KnowledgeRelation[] {
  const output = new Map<string, KnowledgeRelation>();
  for (const seed of seeds) {
    const subjects = aliases.get(normalize(seed.subject)) ?? [];
    const objects = aliases.get(normalize(seed.object)) ?? [];
    for (const subject of subjects) for (const object of objects) {
      if (subject.entityId === object.entityId) continue;
      const relationId = `relation:${subject.entityId}:${seed.predicate}:${object.entityId}`;
      const relation = output.get(relationId) ?? {
        relationId,
        subjectEntityId: subject.entityId,
        predicate: seed.predicate,
        objectEntityId: object.entityId,
        status: seed.status,
        sourceSnapshotIds: [],
        spans: [],
      };
      if (seed.status === 'explicit') relation.status = 'explicit';
      uniquePush(relation.sourceSnapshotIds, seed.snapshotId);
      if (seed.span && !relation.spans.some(span => sameSpan(span, seed.span!))) relation.spans.push(seed.span);
      output.set(relationId, relation);
    }
  }
  return [...output.values()].sort((a, b) => a.relationId.localeCompare(b.relationId));
}

function relationAdjacency(
  relations: KnowledgeRelation[],
  direction: 'forward' | 'reverse',
): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const relation of relations) {
    const key = direction === 'forward' ? relation.subjectEntityId : relation.objectEntityId;
    const value = direction === 'forward' ? relation.objectEntityId : relation.subjectEntityId;
    output[key] ??= [];
    uniquePush(output[key], value);
  }
  for (const values of Object.values(output)) values.sort();
  return output;
}

function relationKind(predicate: string, side: 'subject' | 'object'): KnowledgeEntityKind {
  if (predicate === 'located_in') return 'place';
  if (['active_in', 'occurred_in'].includes(predicate)) return side === 'object' ? 'place' : 'unknown';
  if (predicate === 'participated_in') return side === 'object' ? 'event' : 'person';
  if (predicate === 'member_of') return side === 'object' ? 'organization' : 'person';
  if (predicate === 'caused') return 'event';
  return 'unknown';
}

function validRelationName(value: string): boolean {
  const name = value.trim();
  return name.length >= 2 && name.length <= 30 && !/[：:；;，,。!?！？]/u.test(name);
}

function aliasIndex(entities: KnowledgeEntity[]): Map<string, KnowledgeEntity[]> {
  const index = new Map<string, KnowledgeEntity[]>();
  for (const entity of entities) for (const value of [entity.canonicalName, ...entity.aliases]) {
    const key = normalize(value);
    const items = index.get(key) ?? [];
    items.push(entity);
    index.set(key, items);
  }
  return index;
}

function inferKind(name: string, context: string): KnowledgeEntityKind {
  const value = `${context}${name}`;
  if (/(?:人物|角色|姓名|女神|男神|神祇|神明|国王|女王|皇帝|领主|祭司|法师)/u.test(value)) return 'person';
  // 「山/河/岛」常出现在人名里（如“玲山”），不能仅凭一个字把人名判成地点。
  // 上下文明确写地点时照常识别；仅看名称时只接受较强的地点后缀。
  if (/(?:地点|城市|大陆|地区|草原|森林|神殿)/u.test(context)
    || /(?:城市|城|镇|村|大陆|地区|草原|森林|皇宫|宫殿|神殿|高塔|之塔)$/u.test(name)) return 'place';
  if (/(?:家族|氏族|宗族)/u.test(value)) return 'family';
  if (/(?:议会|教会|协会|组织|公会|军团|学院|神系)/u.test(value)) return 'organization';
  if (/(?:帝国|王国|公国|势力|阵营|部族)/u.test(value)) return 'faction';
  if (/(?:事件|战争|灾难|之战|变乱|革命)/u.test(value)) return 'event';
  if (/(?:纪元|时代|时期)/u.test(value)) return 'era';
  if (/(?:神器|圣物|遗物|王冠|宝剑)/u.test(value)) return 'artifact';
  if (/(?:族|种族|精灵|兽人|矮人)/u.test(value)) return 'species';
  if (/(?:众|全体|成员|群体)/u.test(value)) return 'collective';
  return 'unknown';
}

function locateSpan(snapshot: SourceSnapshot, value: string): KnowledgeSpan | null {
  const startOffset = snapshot.content.indexOf(value);
  return startOffset < 0 ? null : {
    snapshotId: snapshot.snapshotId,
    startOffset,
    endOffset: startOffset + value.length,
  };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function uniquePush<T>(items: T[], value: T): void {
  if (!items.includes(value)) items.push(value);
}

function sameSpan(left: KnowledgeSpan, right: KnowledgeSpan): boolean {
  return left.snapshotId === right.snapshotId
    && left.startOffset === right.startOffset
    && left.endOffset === right.endOffset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(value: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return '';
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[、，,/]/u).map(item => item.trim()).filter(Boolean);
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : [];
}
