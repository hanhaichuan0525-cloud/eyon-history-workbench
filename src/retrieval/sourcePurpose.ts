import type { RetrievalTaskType, SourceSnapshot } from './contracts.ts';
import { templateIndependentText, entityRecognitionText } from './sourceOwnership.ts';

type Source = Pick<SourceSnapshot, 'title' | 'content' | 'sourceType'>;
export interface SourcePurposeDecision {
  use: 'primary' | 'background' | 'mechanism' | 'uncertain' | 'not-used';
  reason: string;
}

/** 命定系统是资料归属，不以某个助理的专用词识别；普通器物的“核心”不在此列。 */
export function isFatedSystemSource(source: Source): boolean {
  if (source.sourceType !== 'worldbook') return false;
  const title = source.title.normalize('NFKC');
  if (/[【\[]命定系统(?:[-·:：/\s][^】\]]*)?[】\]]/u.test(title)
    || /^命定系统(?:$|[-·:：/\s（(]|核心|规则|运行|说明)/u.test(title)) return true;
  // 兼容未带类别标签的旧伊雍核心，以及改题名但仍有本系统专属包装的版本。
  return (/伊雍.{0,16}(?:核心|系统)/u.test(title)
    && /命定契约|虚嗣王权|虚嗣王庭|圣卷见证者|寻根溯源|工作台|<eyon\b/u.test(source.content))
    || (/<虚嗣王权>/u.test(source.content) && /<圣卷见证者>|<命定契约>/u.test(source.content));
}

/** 只看冻结玩家方向；呼语、背景提及和模型首稿名称不能扩大资料权限。 */
export function isExplicitFatedSystemResearch(source: Source, directive: string): boolean {
  const title = source.title.normalize('NFKC');
  const query = entityRecognitionText(directive).normalize('NFKC').trim();
  if (query === title) return true; // 逐字查询条目题名仍是明确研究，包含作者题注也一样。
  const tags = [...title.matchAll(/[【\[]([^】\]]+)[】\]]/gu)].map(m => m[1]!.trim());
  const scope = tags.findIndex(tag => /^命定系统(?:$|[-·:：/])/u.test(tag));
  const tail = title.replace(/[【\[][^】\]]+[】\]]/gu, '').replace(/[（(].*$/u, '').trim();
  const named = tail.replace(/^命定系统\s*[-·:：/]?\s*/u, '');
  const scopedName = scope >= 0 ? tags[scope]!.replace(/^命定系统[-·:：/\s]*/u, '') || (tags[scope + 1] ?? '') : '';
  const names = [tail, named, scopedName]
    .flatMap(name => [name, name.replace(/(?:[-·:：/\s]*(?:核心设定|运行规则|启动规则|交互协议|运行说明|操作说明|输出格式|状态格式|模板|核心|系统))+$/u, '').trim()])
    .filter(name => name.length >= 2 && !/^(?:DLC|WS|角色|人物|扩展|本体|命定系统|核心|系统|模板|规则|协议|交互协议|运行规则|启动规则|运行说明|操作说明|输出格式|状态格式)$/iu.test(name));
  // 伊雍自身的旧机制别称仍可研究，但不能因此授权其他命定系统。
  if (/伊雍/u.test(title) || /<虚嗣王权>/u.test(source.content)) {
    names.push('伊雍', '虚嗣王权', '虚嗣王庭', '圣卷见证者', '命定契约', '历史赎出', '迦南之女');
  }
  const asks = (name: string): boolean => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return new RegExp(`^[「『“"']?${escaped}[」』”"']?$`, 'u').test(query)
      || new RegExp(`(?:研究|探讨|追溯|分析|介绍|了解|讲述|记录|探索|寻根溯源|关于|对)\\s*(?:全部|所有|各个|整个)?\\s*[「『“"']?${escaped}(?=$|[\\s的之「」『』“”"'，,。；;：:]|进行|相关|有关)`, 'u').test(query)
      || new RegExp(`${escaped}[的之](?:来历|身世|历史|沿革|起源|机制|规则|运行|能力|谱系|家系|宗族)`, 'u').test(query);
  };
  return asks('命定系统') || names.some(asks);
}

/** 本地用途建议，不编译史实、不执行模板、不要求作者提供新字段。 */
export function assessSourcePurpose(source: Source, input: {
  taskType: RetrievalTaskType; query: string; explicitlySelected?: boolean;
}): SourcePurposeDecision {
  try {
    if (source.sourceType !== 'worldbook') return { use: 'primary', reason: 'existing-task-record' };
    if (isFatedSystemSource(source)) {
      // 分类标签不取消已知经历；混合全文仍交付，提示词区分事实与操作指令。
      if (hasIndependentFacts(source.content)) return { use: 'uncertain', reason: 'fated-system-mixed-facts-preserved' };
      return { use: input.explicitlySelected || isExplicitFatedSystemResearch(source, input.query) ? 'mechanism' : 'not-used',
        reason: 'fated-system-runtime-not-historical-evidence' };
    }
    // 混合资料和人物附件从宽，不能因含规则、核心、EJS、JSONPatch就整条丢弃。
    if (hasIndependentFacts(source.content)) return { use: 'uncertain', reason: 'mixed-facts-preserved' };
    const title = source.title.normalize('NFKC');
    const content = source.content;
    const query = input.query.normalize('NFKC');
    const cleanTitle = title.replace(/[【\[][^】\]]+[】\]]/gu, '').replace(/[（(].*$/u, '').trim();
    const explicit = input.explicitlySelected || (cleanTitle.length >= 4 && query.includes(cleanTitle));
    if (isPureUpdateProtocol(source)) return { use: explicit ? 'mechanism' : 'not-used', reason: 'pure-update-protocol' };
    const taskTemplate = /任务.*规则|委托.*规则/u.test(title)
      && /<task_info>/u.test(content) && /触发机制|输出格式/u.test(content);
    if (taskTemplate) return {
      use: explicit || /(?:生成|领取|提交|结算)(?:公会|个人|一份|本次|本轮|新的)?(?:任务|委托)|(?:任务|委托)(?:的)?(?:生成|结算|奖励(?:计算|规则|机制))/u.test(query)
        ? 'mechanism' : 'not-used', reason: 'task-generation-protocol',
    };
    // 装备条目常把格式与实际流通/能力机制混写：从宽留全文，只提示用途，不抹掉世界边界。
    if (/技能.*装备.*生成规则/u.test(title) && /(?:技能|装备|道具|资产)生成格式/u.test(content)
      && /品质\s*[:：]|标签\s*[:：]/u.test(content)) return {
      use: 'mechanism', reason: 'mixed-generation-mechanism-preserved',
    };
    const outputTemplate = /文字创作物.*成品|出版物.*输出格式/u.test(title)
      && /强制输出格式|Raw Text/u.test(content) && /\[WritingBook:|\$\{[^}]+\}/u.test(content);
    const characterTemplate = /角色生成/u.test(title) && /charThink|CHAR_COMPILE/u.test(content)
      && /CALC|FOR_EACH|EMIT/u.test(content);
    if (outputTemplate || characterTemplate) return {
      use: explicit ? 'mechanism' : 'not-used', reason: 'output-template-not-historical-evidence',
    };
    // 登记格式里的地区/机构代码不是当地事件；出版主题确实相关时仍读整份原文。
    const publicationRegister = /书号.*规则|ASBN/iu.test(title)
      && /ASBN/iu.test(content) && /地区代码|机构代码/u.test(content) && /基本格式|字段说明/u.test(content);
    if (publicationRegister) {
      const publishing = /出版|发行|印刷|出版社|书局|书号|ASBN/iu.test(query)
        || [...content.matchAll(/^\s*[A-Z]{2,4}\s*[:：]\s*([^\n（(]+?(?:书局|印刷所|出版社|报社))/gmu)]
          .some(match => query.includes(match[1]!.trim()));
      return { use: explicit || publishing ? 'background' : 'not-used', reason: 'publication-register-topic' };
    }
    return { use: 'uncertain', reason: `${input.taskType}-unclassified-preserved` };
  } catch {
    // 辅助筛选失效只降级当前来源；不退回整本注入，也不阻断任务。
    return { use: 'uncertain', reason: 'local-purpose-check-unavailable' };
  }
}

/** 题名与协议共证；任何已识别叙事值均保留。与蝴蝶消费端使用同一判据。 */
export function isPureUpdateProtocol(source: Pick<Source, 'title' | 'content'>): boolean {
  if (!/(?:MVU|变量).*(?:更新|输出)(?:规则|指令|格式)/iu.test(source.title.normalize('NFKC'))) return false;
  const protocol = /variables_update_(?:rules|format)\s*:|<variables_update_rules>|JSON\s*Patch|<UpdateVariable>/iu.test(source.content)
    || (/<当前[^<>\n]{0,60}变量>/u.test(source.content) && /(?:check|type)\s*[:：]/u.test(source.content));
  if (!protocol) return false;
  return !hasIndependentFacts(source.content);
}

export function hasIndependentFacts(content: string): boolean {
  if (/<[^<>\n]{1,60}(?:角色详情|人物档案)>|const\s+profile\s*=/u.test(content)) return true;
  const lines = templateIndependentText(content).split(/\r?\n/u);
  // 无字段的混合散文也从宽；不能把“姓名/背景故事”当作唯一合法写法。
  if (lines.some(line => !/[:：]/u.test(line) && /^[\p{Script=Han}]{2,16}(?:曾|在|出生于|诞生于|居住|来自|死于)/u.test(line.trim())
    && !/^(?:当|若|请|应该|不得|必须|只能|禁止|更新|每次|变量|角色|人物|世界|模型|系统|主角|规则|格式|示例|注意|说明)/u.test(line.trim()))) return true;
  // 未求值分支内的字面事实只保护混合来源，不把分支升格为时间/身份硬事实。
  const fieldLines = [...lines, ...content.split(/\r?\n/u)];
  return fieldLines.some((line, index) => {
    const field = line.match(/(?:背景故事|人物经历|历史事件|世界设定|back_story)["']?\s*[:：]\s*(.*)$/u);
    if (!field) return false;
    const value = field[1]!.trim();
    const text = (value && !/^[|>][+-]?$/u.test(value) ? value
      : fieldLines.slice(index + 1).find(row => row.trim() && !/^\s*(?:#|\/\/)/u.test(row)) ?? '')
      .trim().replace(/^["'`]|["'`,;}]$/gu, '').trim();
    // EJS被遮蔽后不能越过字段边界，把闭合标签、代码围栏或下个schema字段当作历史值。
    if (/^(?:<\/[^>]+>|<%|<[^>]+>$|`|~{3,}|\[\s*\]|\{\s*\})/u.test(text)
      || (!value && /^[^\s:：]{1,60}\s*[:：]/u.test(text))) return false;
    return Boolean(text) && !/^(?:check|type|format|range|category|enum|required|default)\s*[:：]/iu.test(text)
      && !/^(?:string|number|boolean|unknown|any|never|null|undefined|字符串|文本类型)(?:\s*[\[\]?;|]|\s|$)/iu.test(text)
      && !/^(?:z\.|\$\{|\{\s*(?:["']?(?:type|check)["']?\s*:|\[|$)|<UpdateVariable>|JSONPatch|\(\d+[~-]\d+\s*token)/u.test(text);
  });
}

/** 仅匹配视图去代码噪音，入选原文/哈希/偏移从不修改。静态人物模板先从宽。 */
export function retrievalSignalText(source: Pick<Source, 'title' | 'content'>): string {
  if (/const\s+profile\s*=/u.test(source.content)) return source.content;
  return entityRecognitionText(source.content);
}
