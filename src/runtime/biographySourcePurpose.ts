import type { ContextSource } from '../core/context.ts';
import { assessSourcePurpose, hasIndependentFacts, isFatedSystemSource, isPureUpdateProtocol } from '../retrieval/sourcePurpose.ts';

type Source = Pick<ContextSource, 'title' | 'content' | 'sourceType'>;

/** 按声明的系统归属或题名/协议共证识别；普通“核心”、EJS和同地点不构成证据。 */
export function isBiographyMechanismSource(source: Source): boolean {
  if (source.sourceType !== 'worldbook') return false;
  if (isFatedSystemSource(source)) return !hasIndependentFacts(source.content);
  if (isPureUpdateProtocol(source)) return true;
  const title = source.title.normalize('NFKC');
  const content = source.content;
  const runtimeTitle = /(?:MVU|变量).*(?:更新规则|更新指令)|脚本运行规则|工作台操作(?:说明|规则)|伊雍对话格式/iu.test(title);
  const runtimeContent = /JSONPatch|变量更新|脚本|工作台|<eyon\b/iu.test(content);
  return runtimeTitle && runtimeContent && !hasIndependentFacts(content);
}

/** 权限只来自冻结的玩家指令，不能来自模型规划/初稿中新造的名字和引用。 */
export function mayUseBiographySource(source: Source, directive: string): boolean {
  if (isFatedSystemSource(source)) {
    return assessSourcePurpose(source, { taskType: 'biography', query: directive }).use !== 'not-used';
  }
  if (!isBiographyMechanismSource(source)) return true;
  const text = directive.normalize('NFKC');
  if (/伊雍核心|虚嗣王权|虚嗣王庭|圣卷见证者|命定契约|历史赎出|迦南之女/u.test(text)) return true;
  return /^\s*[「『“"']?伊雍[」』”"']?\s*$/u.test(text)
    || /(?:对|关于|研究|探讨|追溯|探索|讲述|记录|了解|寻根溯源)\s*[「『“"']?伊雍/u.test(text)
    || /伊雍[的之]/u.test(text);
}

export const BIOGRAPHY_SOURCE_PURPOSE_BLOCK = [
  '<BIOGRAPHY_SOURCE_PURPOSE>',
  '资料相关不等于历史在场。运行核心、工作台操作、EJS条件/脚本和输出格式属于机制参考，不是历史事件、器物或登场人物；不得因同地点、同名或初稿已写到就升格为史实。',
  '混合条目中的明确人物/世界设定仍有约束力，但所有命定系统的核心机制与指令都不能整篇当作历史身份证。系统助理的讲述身份不等于曾参与所写历史；不可把任何系统核心无据实体化为金属球、圣物或工坊器件。',
  '玩家明确研究某个命定系统或其机制时，只读取对应系统设定，不因此开放其他系统；只能依据原句解释存在方式与已确认经历。既有正文中的真实行动/契约后果须承接，不得从操作规则反造古代事件。普通史料中的人物身份、生卒、事件年龄与来源权限保持原约束。',
  '规划或首稿造出的名称只触发查证，补查到同名条目并不证明该实体属于本事件/时代。复核时修正无依据的借名或物化，不输出技术说明，不新增字段。',
  '</BIOGRAPHY_SOURCE_PURPOSE>',
];
