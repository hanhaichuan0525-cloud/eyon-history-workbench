import type { ContextSource, GenealogyContextBundle } from '../core/context.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';
import {
  buildGenealogyEvidenceRoster,
  resolveGenealogyFocusChronology,
} from '../core/genealogyEvidence.ts';
import { renderContinuityView } from '../runtime/continuityAnchors.ts';
import {
  extendTaskCitationRegistry,
  maskTaskCitationIdentifiers,
  taskCitationRegistry,
} from '../retrieval/citations.ts';
import {
  buildActiveEvidenceView,
  renderActiveEvidenceBlock,
  requestedEraFromText,
} from './activeEvidence.ts';

const REFERENCE_TOTAL_LIMIT = 60_000;
const REFERENCE_ITEM_LIMIT = 8_000;
const REFERENCE_ITEM_COUNT_LIMIT = 28;

export interface GenealogyRuleSet {
  generationContract: string;
}

interface GenealogyPromptInput {
  requestId: string;
  directive: string;
  generationInput: GenealogyGenerationInput;
  context: GenealogyContextBundle;
  rules: GenealogyRuleSet;
}

export function buildGenealogyApiPrompt(input: GenealogyPromptInput): string {
  const registry = genealogyCitationRegistry(input);
  return maskTaskCitationIdentifiers([
    '<GENEALOGY_TASK>',
    '根据只读资料生成宗族谱系。资料只用于推理，绝对不能把资料包本身当作答案返回。',
    '</GENEALOGY_TASK>',
    '<GENEALOGY_RULES>',
    input.rules.generationContract.trim(),
    '</GENEALOGY_RULES>',
    ...genealogyActiveEvidenceBlock(input),
    buildReferenceDataSection(input),
    buildMandatoryOutputContract(input),
  ].join('\n\n'), registry);
}

function genealogyActiveEvidenceBlock(input: GenealogyPromptInput): string[] {
  const era = requestedEraFromText(
    `${input.directive}\n${input.context.currentWorld.time}\n${input.context.evidenceBundle.query}`,
  );
  return [
    renderActiveEvidenceBlock(
      buildActiveEvidenceView(input.context.evidenceBundle, era),
      { citationRegistry: genealogyCitationRegistry(input) },
    ),
    '<GENEALOGY_STRICT_CHRONOLOGY>',
    '谱系是关系数据，不是叙事：人物生卒年必须与既有资料严格相容。',
    '1. 每个节点的 birth/death 必须完整、自洽（同一人物在全部节点一致）；',
    '2. 祖先的出生年份必须早于后代的出生年份至少 12 年；',
    '3. 不得用「缺席叙事」「异界来源」「时间错位」合理化生卒冲突——生卒是硬事实，冲突即重写；',
    '4. 生卒先采用当前 Canon 的明确时间原点；中心 MVU 人物另须逐字遵守 focusChronology：世界书整条目的明确生年或实际年龄优先，其次是 MVU 整条目，仍无锚时才结合人物资料和代际关系生成一个 approximate 约年。不得使用外貌年龄、心理年龄或自由叙事中的偶发年龄。',
    '5. 已验证的非 MVU 节点同样可供墟境参考；canInjectToRuin 填 true。实际可复用性由当前历史版本判断，旧 onlyMvuNodesCanInjectToRuin 仅为兼容字段。',
    '6. historyRefs 可以省略或填 []；传记内部标识由脚本关联，禁止自行编造。',
    '</GENEALOGY_STRICT_CHRONOLOGY>',
    ...renderContinuityView(input.context.continuityView),
  ];
}

export function buildGenealogyRepairPrompt(input: GenealogyPromptInput & {
  validationError: string;
}): string {
  const registry = genealogyCitationRegistry(input);
  return maskTaskCitationIdentifiers([
    '<GENEALOGY_REPAIR_TASK>',
    '上一次回答未通过本地校验。请从头重新生成完整宗族结果，不要修改、复述或包装上一次回答。',
    '常见错误是回显 REFERENCE_DATA，或输出 target、clan、members 等旧式字段；这些都不是答案。',
    `本地错误摘要：${input.validationError.slice(0, 1600)}`,
    '</GENEALOGY_REPAIR_TASK>',
    '<GENEALOGY_RULES>',
    input.rules.generationContract.trim(),
    '</GENEALOGY_RULES>',
    ...genealogyActiveEvidenceBlock(input),
    buildReferenceDataSection(input),
    buildMandatoryOutputContract(input),
  ].join('\n\n'), registry);
}

function genealogyCitationRegistry(input: GenealogyPromptInput) {
  return extendTaskCitationRegistry(
    taskCitationRegistry(input.context.evidenceBundle),
    input.context.sourceIndex.map(source => source.sourceId),
  );
}

function buildReferenceDataSection(input: GenealogyPromptInput): string {
  const referenceData = {
    requestId: input.requestId,
    playerDirective: input.directive,
    focusCharacter: input.generationInput.focusCharacter,
    depth: input.generationInput.depth,
    genealogyEvidenceRoster: buildGenealogyEvidenceRoster(
      input.generationInput,
      input.context,
    ),
    focusChronology: resolveGenealogyFocusChronology(
      input.generationInput,
      input.context,
    ),
    currentWorld: input.context.currentWorld,
    sources: projectActiveSources(input),
  };
  return [
    '<REFERENCE_DATA_READ_ONLY>',
    JSON.stringify(referenceData),
    '</REFERENCE_DATA_READ_ONLY>',
  ].join('\n');
}

/**
 * R-02：正式链不再二次选源。sourceIndex 已由统一检索按 receipt.selected 顺序、
 * 逐 EvidencePassage 原样投影（见 activeRetrieval.selectActivePassageSources），
 * 因此这里只做顺序保持的原样投影，统一 passage budget 是唯一预算。
 * 仅保留总量保险上限防极端体积，不做重新打分/过滤/截断选源。
 */
function projectActiveSources(input: GenealogyPromptInput): ContextSource[] {
  const projected: ContextSource[] = [];
  let usedCharacters = 0;
  for (const source of input.context.sourceIndex) {
    if (projected.length >= REFERENCE_ITEM_COUNT_LIMIT) break;
    const remaining = REFERENCE_TOTAL_LIMIT - usedCharacters;
    if (remaining <= 0) break;
    const content = source.content.trim().slice(
      0,
      Math.min(REFERENCE_ITEM_LIMIT, remaining),
    );
    if (!content) continue;
    projected.push({ ...source, content });
    usedCharacters += content.length;
  }
  return projected;
}


function buildMandatoryOutputContract(input: {
  requestId: string;
  generationInput: GenealogyGenerationInput;
}): string {
  const { focusCharacter, depth } = input.generationInput;
  const fixedHeader = {
    schema: 'eyon.genealogy.v2',
    requestId: input.requestId,
    focusCharacterId: focusCharacter.mvuId,
    focusCharacterName: focusCharacter.name,
    depth,
  };
  return [
    '<MANDATORY_FINAL_OUTPUT_CONTRACT>',
    '这是唯一输出契约，优先级高于前文中的任何示例。',
    '只返回一个 JSON 对象；不得使用 Markdown，不得附加解释。',
    `最终对象的五个固定字段必须逐字复制：${JSON.stringify(fixedHeader)}`,
    '在这五个固定字段之后，只能补充 nodes、edges、referenceSummary、qualityChecks。',
    '顶层只允许：schema、requestId、focusCharacterId、focusCharacterName、depth、nodes、edges、referenceSummary、qualityChecks。',
    '禁止返回 REFERENCE_DATA_READ_ONLY，禁止输出 taskType、scope、currentWorld、worldbookContext、recentContext、characterContext、genealogyContext、biographyRefs、butterflyRefs、sourceIndex、warnings。',
    '禁止输出 target、clan、origins、members、relationships、record_conflicts 或任何其他顶层字段。',
    'nodes、edges 必须是数组；referenceSummary、qualityChecks 必须是对象。',
    '每个 node 必须完整包含 GENEALOGY_RULES 中列出的全部字段，不得缩写。',
    '每个 node 必须包含 profile:{personality,lifeExperience}；两项均为简短、具体、可供传记与墟境参考的非空文本。',
    '建立关系边前，必须先在内部判定中心人物属于：本土原生、同世界原肉身时间穿越、跨世界原肉身穿越、灵魂穿越/夺舍、转生、收养，或召唤/造物/克隆/神造中的哪一类；不得输出该内部分类。',
    '同世界原肉身时间穿越者只追溯其出生血缘，不能把抵达年代的人物写成祖辈；跨世界原肉身穿越者不得凭空获得现世界父母；灵魂穿越/夺舍必须把肉身血缘与原灵魂血缘分开；转生只把今生亲属写入当前生物谱系；收养关系必须使用收养边；召唤、造物、克隆或神造者仅在设定支持时建立对应亲缘。',
    'GENEALOGY_EVIDENCE_ROSTER 是“已知事实锁”，不是人物准入白名单。roster 中已有的人名、别名和亲缘必须原样保留，禁止改名、换关系或用原创人物顶替；roster 之外允许合理补全亲属。',
    '补全人物属于本次谱系原创：node.provenance 必须为 generated，node.sourceRefs 必须为 []，不得伪造 S 句柄、世界书出处、MVU 身份或 Canon 身份。原创关系的 edge.sourceRefs 同样必须为 []。旧谱系里的 generated 人物只能作为低权连续性建议复用，不能反过来证明其为权威设定。',
    '填充时先保留全部事实锁，再按正常生物/收养机制补足缺口。至少兼顾父系和母系：优先父母，再补父系祖辈或叔伯姑、母系祖辈或舅姨，其后才是兄弟姐妹、堂表亲与允许范围内的后代。不得把两条支系全部写成同一父系，也不得为跨世界原肉身、造物或无法成立的出生机制硬造本世界父母。',
    '谱系应在返回前检查父母、祖辈、子女及后代的出生年份没有倒置；focusChronology 有 birth 时必须逐字采用该出生纪元与年份并按 instruction 标为 exact 或 approximate；mode=model-inferred 时中心人物也必须生成一个 precision=approximate 的约略出生年，label 明示“谱系推断”。不得用当前年份减外貌年龄。',
    '为了形成真正的家族树，旁系人物必须同时提供可落到家庭结构的边：兄弟姐妹应与中心人物共享至少一名 parent（或有明确 sibling 边）；叔伯姑须与对应父系家长建立 sibling/halfSibling，舅姨须与对应母系家长建立 sibling/halfSibling；堂表亲优先用 parent 边连接到其父母。uncleAunt/cousin 等与中心人物的概括边可以保留，但不能替代上述结构边。',
    `depth.maxPerGeneration=${depth.maxPerGeneration} 是每代尽量达到的目标，也是绝不能超过的硬上限。事实锁优先占位；剩余名额用互不重名、关系可解释的 generated 亲属补齐。只有血缘载体、代数或年龄硬约束确实不允许时才可少于目标，并在 referenceSummary.brief 简述原因。`,
    'birth/death 的月份或日期未知时必须写 null，禁止用 0；professions 不得为空数组，无法判断时写 ["职业不详"]。',
    '所有非空 sourceRefs 只能引用 TASK_CITATION_CONTRACT_V2.allowedSourceRefs 中实际列出的 S 句柄。事实锁人物/关系引用对应 roster 来源；generated 人物与原创关系必须使用空 sourceRefs。脚本会按是否命中事实锁重新判定 provenance，不要为通过校验伪造来源。',
    '</MANDATORY_FINAL_OUTPUT_CONTRACT>',
  ].join('\n');
}
