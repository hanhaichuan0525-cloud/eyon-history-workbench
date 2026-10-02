export interface CurrentSceneReference {
  directive: string;
  location: string;
}

export interface CurrentSceneEvidenceExcerpt {
  sourceId: string;
  title: string;
  content: string;
}

/**
 * 当前场景的自然语言快照。
 *
 * 它只保存地点锚与附近聊天原文，不把「用途 / 所有人 / 居住者」提前解析成
 * 脚本字段。明确事实、强烈暗示与未知之间的边界仍由生成模型结合原文判断。
 */
export interface CurrentSceneSnapshot {
  location: string;
  evidence: CurrentSceneEvidenceExcerpt[];
}

export interface TaskSubjectBoundaryInput {
  taskType: 'biography' | 'ruin';
  directive: string;
  focusText?: string;
  explicitLocation?: string;
  currentLocation?: string | null;
}

const CURRENT_SCENE_DEICTIC = /(?:这里|此处|当前(?:所在|所处)?(?:地点|场景)?|眼前|我们所在(?:的)?|这(?:座|个|间|片|处|所)[^，。；！？\n]{0,18}|这[^，。；！？\n]{1,18}(?:中|里|内|上|下|旁|附近)(?:的)?)/u;
const CURRENT_SCENE_EVIDENCE_LIMIT = 4;

/**
 * 玩家使用当前场景指示语，或直接点名当前地点链末端的具名对象时，
 * 才把 MVU 地点作为对象的当前身份锚。仅点名上级城市或泛称房间不会触发，
 * 避免把「当前地点」误当成全局硬约束。
 */
export function resolveCurrentSceneReference(
  directive: string,
  currentLocation: string | null | undefined,
): CurrentSceneReference | null {
  const location = currentLocation?.trim() ?? '';
  if (!location) return null;
  const normalizedDirective = directive.normalize('NFKC');
  if (!CURRENT_SCENE_DEICTIC.test(normalizedDirective)
    && !mentionsDeepestNamedCurrentLocation(normalizedDirective, location)) return null;
  return { directive, location };
}

export function renderCurrentSceneReference(
  directive: string,
  currentLocation: string | null | undefined,
): string[] {
  const reference = resolveCurrentSceneReference(directive, currentLocation);
  if (!reference) return [];
  return [
    '<CURRENT_SCENE_REFERENCE>',
    '玩家使用了当前场景指代，或直接点名了 MVU 当前地点链末端的具名对象。以下地点链是这次对象的父级地点锚：',
    reference.location,
    '把玩家原话中的“这 / 这里 / 当前”等表达作为对整条地点链的指代来理解，不要拆成零散关键词另猜城市。若对象是这条链中的建筑、房间、设施或器物，其所属城市、势力与上级建筑以该地点链为准。',
    '其他史料中的同名地点、相关人物所在城市或相似建筑只能提供背景与素材，不能替换对象的父级地点，也不能把整段历史搬到另一座城市、国家或建筑群。',
    '这不是封死创作：可以自由补写该地点链内部的房间、回廊、花圃、工匠、构造和日常；只有明确改变对象所属地点的写法才算冲突。',
    '</CURRENT_SCENE_REFERENCE>',
  ];
}

/**
 * 从当前指令附近的聊天原文中挑出一个很小的证据窗口。
 *
 * 这里只按「末端具名对象是否被直接写出」和消息远近排序，不解析句法、不猜用途，
 * 避免再次把自然语言压成脆弱的关键词规则。没有可用原文时仍返回地点锚。
 */
export function buildCurrentSceneSnapshot(
  directive: string,
  currentLocation: string | null | undefined,
  recentSources: readonly CurrentSceneEvidenceExcerpt[],
): CurrentSceneSnapshot | null {
  const reference = resolveCurrentSceneReference(directive, currentLocation);
  if (!reference) return null;

  const normalizedDirective = normalizeComparableText(directive);
  const deepest = reference.location
    .split(LOCATION_HIERARCHY_SEPARATOR)
    .map(segment => segment.trim())
    .filter(Boolean)
    .at(-1) ?? '';
  const normalizedDeepest = normalizeComparableText(deepest);
  const usable = recentSources
    .map((source, index) => ({ source, index }))
    .filter(({ source }) => {
      const content = source.content.trim();
      return Boolean(content) && normalizeComparableText(content) !== normalizedDirective;
    });
  const directlyNamed = normalizedDeepest
    ? usable.filter(({ source }) => normalizeComparableText(source.content).includes(normalizedDeepest))
    : [];
  const selected = new Map<string, { source: CurrentSceneEvidenceExcerpt; index: number }>();
  for (const item of directlyNamed.slice(-2)) selected.set(item.source.sourceId, item);
  // 先补最近的消息，再恢复为时间顺序输出；否则窗口已满时反而会留下较旧消息。
  for (const item of [...usable.slice(-CURRENT_SCENE_EVIDENCE_LIMIT)].reverse()) {
    if (selected.size >= CURRENT_SCENE_EVIDENCE_LIMIT) break;
    selected.set(item.source.sourceId, item);
  }

  return {
    location: reference.location,
    evidence: [...selected.values()]
      .sort((left, right) => left.index - right.index)
      .map(({ source }) => ({
        ...source,
        content: source.content.trim(),
      })),
  };
}

export function renderCurrentSceneSemanticSnapshot(
  snapshot: CurrentSceneSnapshot | null | undefined,
): string[] {
  if (!snapshot) return [];
  return [
    '<CURRENT_SCENE_SEMANTIC_SNAPSHOT>',
    `当前对象地点锚：${snapshot.location}`,
    '以下是当前场景附近的聊天原文，不是脚本替你判好的“用途/归属”字段。请通读原意：直接明说的当前身份、使用者、用途与状态可以作为现状事实；由行为、陈设、出入规则或长期使用形成的暗示可以作为有根据但允许改写措辞的解释；仍然含糊的部分保持未知。',
    ...snapshot.evidence.flatMap(item => [
      `【${item.title}｜${item.sourceId}】`,
      item.content,
    ]),
    '这些原文只约束历史最终抵达的“现在”。不得把现时名称、用途、所有人或居住者无据投射到建立之初；历史可以自由演变，只需合理抵达有据的现状。若原文没有给出某项信息，不得假装脚本已经确认。',
    '</CURRENT_SCENE_SEMANTIC_SNAPSHOT>',
  ];
}

function normalizeComparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

const PLACE_NAME = '[\\p{L}\\p{N}·]{1,20}(?:帝国|王国|公国|共和国|大陆|行省|省|郡|州|城堡群|城堡|皇宫|王宫|圣都|帝都|城市|城|镇|村|岛|山脉|高塔)';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const LOCATION_HIERARCHY_SEPARATOR = /[\s\-—–→>/\\|:：]+/gu;
const GENERIC_LOCATION_SEGMENT = /^(?:大陆(?:中|东|西|南|北|东北|东南|西北|西南)?部|皇宫(?:高塔)?|王宫(?:高塔)?|高塔|城堡群|城堡|宫殿|花室|房间|回廊|庭院)$/u;

function normalizeLocation(value: string): string {
  return value
    .normalize('NFKC')
    .replace(LOCATION_HIERARCHY_SEPARATOR, '')
    .replace(/[的之]/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function mentionsDeepestNamedCurrentLocation(directive: string, currentLocation: string): boolean {
  const deepest = currentLocation
    .split(LOCATION_HIERARCHY_SEPARATOR)
    .map(segment => segment.trim())
    .filter(Boolean)
    .at(-1);
  if (!deepest || GENERIC_LOCATION_SEGMENT.test(deepest.normalize('NFKC'))) return false;
  const normalizedTarget = normalizeLocation(deepest);
  return normalizedTarget.length >= 3
    && normalizeLocation(directive).includes(normalizedTarget);
}

/**
 * 四模块共用的轻量对象边界。只锁定玩家原话、显式时空与当前身份的证据边界；
 * 对象是个体、集合、行业还是群体，以及它靠什么延续，仍交给模型理解。
 */
export function renderTaskSubjectBoundary(input: TaskSubjectBoundaryInput): string[] {
  const focusText = input.focusText?.trim() || input.directive.trim();
  const currentReference = resolveCurrentSceneReference(
    [input.directive, focusText, input.explicitLocation].filter(Boolean).join('\n'),
    input.currentLocation,
  );
  return [
    '<TASK_SUBJECT_BOUNDARY>',
    `玩家完整原话：${input.directive}`,
    `本轮研究对象/探索焦点原文：${focusText}`,
    ...(input.explicitLocation ? [`玩家显式地点范围：${input.explicitLocation}`] : []),
    '把对象原文当成一个完整意思：所属、用途、数量范围、群体尺度与行业/制度含义都是对象边界，不得拆成关键词后丢失。例如“某城的所有井盖”是设施集合，“某城的井盖业”是围绕生产、供应、安装与维护形成的行业生态；两者可共享史料，但不是同一对象。',
    '在内部先判断什么维持它还是同一对象（身体、材料、地点、群体、组织、功能、名称或所有关系）。它出现之前只能写前身、所在地前史、谱系或形成条件，不得冒充对象本身已经存在。这是自然语言理解，不要输出新的类型枚举。',
    ...(currentReference
      ? [
          `当前 MVU 地点链：${currentReference.location}`,
          '这条 MVU/当前正文只直接证明对象在“现在”的位置、所属、使用者、用途与状态；它不自动证明建立时间、早期用途或一直沿用当前名称。只有带日期的其他史料才能锁定过去。',
        ]
      : [
          '若资料库没有同名实体，但玩家已给出完整可辨的研究对象，就把它视为玩家定义的开放对象继续；不得仅因没有世界书专门条目而中断。',
        ]),
    '史料空白允许提出一条可成立的历史解释；未有直接证据时，把发明限制在对象、当地生活与必要因果桥梁内，不自动升格成建国史、新皇室谱系、外交战争、国运神器或跨世纪制度。',
    '这些是写作前的思考边界，不是要求输出的结构化字段，也不得因语义不确定而返回错误。',
    '</TASK_SUBJECT_BOUNDARY>',
  ];
}

/**
 * 地点校验采用 fail-open：层级分隔、自然连写或同一具名父级都视为相容。
 * 只有候选地点既不属于整条当前链、也不含最深具名父级时，才具备“外迁”证据。
 */
function isCompatibleCurrentLocation(
  currentLocation: string,
  place: string,
  targetName: string,
): boolean {
  const current = normalizeLocation(currentLocation);
  const candidate = normalizeLocation(place);
  if (!candidate || current.includes(candidate) || candidate.includes(current)) return true;

  const target = normalizeLocation(targetName);
  const deepestNamedParent = currentLocation
    .split(LOCATION_HIERARCHY_SEPARATOR)
    .map(segment => segment.trim())
    .filter(Boolean)
    .reverse()
    .find(segment => {
      const normalized = normalizeLocation(segment);
      return normalized.length >= 3
        && normalized !== target
        && !GENERIC_LOCATION_SEGMENT.test(segment.normalize('NFKC'));
    });
  return deepestNamedParent
    ? candidate.includes(normalizeLocation(deepestNamedParent))
    : false;
}

/**
 * 只识别「对象明确位于另一地点」这类直陈关系。
 * 仅仅提到外地材料、人物来源或旅行不会触发，以免压缩合理想象空间。
 */
export function findExplicitCurrentSceneRelocation(input: {
  directive: string;
  currentLocation: string | null | undefined;
  targetName: string;
  text: string;
}): string | null {
  const reference = resolveCurrentSceneReference(input.directive, input.currentLocation);
  const target = input.targetName.trim();
  if (!reference || !target) return null;

  const targetPattern = escapeRegExp(target);
  const relationPatterns = [
    new RegExp(`(${PLACE_NAME})\\s*(?:的|内的|中的|境内的)\\s*(?:(?:高塔|顶端|上层|内部|附属建筑|建筑群|皇宫|王宫)\\s*(?:的|内|中)?\\s*){0,2}${targetPattern}`, 'gu'),
    new RegExp(`${targetPattern}[^。！？\\n]{0,24}?(?:位于|坐落(?:于)?|隶属(?:于)?|属于|建在|设在|置于)\\s*(${PLACE_NAME})`, 'gu'),
  ];
  for (const pattern of relationPatterns) {
    for (const match of input.text.matchAll(pattern)) {
      const place = match[1]?.trim().replace(/^(?:在|于|从|由|向|往|自)+/u, '');
      if (place && !isCompatibleCurrentLocation(reference.location, place, target)) return place;
    }
  }
  return null;
}
