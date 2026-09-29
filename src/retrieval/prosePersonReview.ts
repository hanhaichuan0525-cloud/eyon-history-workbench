import type { StagePersonAssessment } from './temporal.ts';

const AGE_NUMBER = '[0-9零〇一二两三四五六七八九十百千]{1,8}';
const APPEARANCE_AGE_MARKERS = /外貌|外表|容貌|看起来|看上去|视觉|生理年龄|心理年龄|少女模样|少年模样/u;

export interface PassageTimeWindow {
  era: string | null;
  startYear: number | null;
  endYear: number | null;
}

export interface RevisionObjectStateEvidence {
  statement: string;
  temporalScope?: string | null;
}

export interface ProseSoftReviewResult {
  content: string;
  correctedNames: string[];
}

/**
 * 只识别“某个已知人物明确被写成 N 岁”的窄语法，不拆句、不推断外貌年龄。
 * 年龄窗口两侧各放宽 1 岁，容纳生日尚未到来的自然误差；更大的偏差才进入可选复核。
 */
export function explicitAgeConflictNames(
  content: string,
  assessments: readonly StagePersonAssessment[],
): string[] {
  const conflicts: string[] = [];
  for (const assessment of assessments) {
    if (assessment.state !== 'alive') continue;
    const bounds = [assessment.ageRange.start, assessment.ageRange.end]
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (bounds.length === 0) continue;
    const minimum = Math.min(...bounds) - 1;
    const maximum = Math.max(...bounds) + 1;
    const mentions = explicitAgeMentionsForPerson(content, assessment.name);
    if (mentions.some(mention => mention.age < minimum || mention.age > maximum)) {
      conflicts.push(assessment.name);
    }
  }
  return conflicts;
}

/**
 * 最终成稿的 fail-soft 年龄护栏。
 *
 * 它不改写人物经历、不推断生日，也不要求模型再调用一次；只在人物时间轴已经给出
 * 可计算年龄、正文又逐字写出明显冲突的「N 岁」时，删除这段不必要的精确岁数。
 * 外貌/心理/视觉年龄保持原文，模糊情况保持原文。
 */
export function softenExplicitAgeConflicts(
  content: string,
  assessments: readonly StagePersonAssessment[],
): ProseSoftReviewResult {
  const edits: Array<{ start: number; end: number; replacement: string; name: string }> = [];
  for (const assessment of assessments) {
    if (assessment.state !== 'alive') continue;
    const bounds = [assessment.ageRange.start, assessment.ageRange.end]
      .filter((value): value is number => value !== null && Number.isFinite(value));
    if (bounds.length === 0) continue;
    const minimum = Math.min(...bounds) - 1;
    const maximum = Math.max(...bounds) + 1;
    for (const mention of explicitAgeMentionsForPerson(content, assessment.name)) {
      if (mention.age >= minimum && mention.age <= maximum) continue;
      edits.push({
        start: mention.start,
        end: mention.end,
        replacement: mention.nameForm,
        name: assessment.name,
      });
    }
  }
  return applyEdits(content, edits);
}

/**
 * 从当前 revision 的自然语言事实中，发现「同一原件已明确终止、后续段又无解释使用」的窄冲突。
 * 仅接受可比对的同纪元年份；时间、对象身份或状态有歧义就返回空数组。
 */
export function revisionObjectStateConflictNames(
  content: string,
  objectNames: readonly string[],
  passageTime: PassageTimeWindow,
  evidence: readonly RevisionObjectStateEvidence[],
): string[] {
  return collectTerminalObjectConstraints(objectNames, passageTime, evidence)
    .filter(constraint => conflictingObjectSentences(content, constraint.name).length > 0)
    .map(constraint => constraint.name);
}

/**
 * 把已经通过校验的前文中、与已知物品逐字关联的明确状态变化投影为本篇临时证据。
 * 只切句并识别既有状态词，不猜新物品、不写入 Canon；模糊句保持为空。
 */
export function collectPassageObjectStateEvidence(
  content: string,
  objectNames: readonly string[],
  temporalScope: string | null,
): RevisionObjectStateEvidence[] {
  if (!temporalScope) return [];
  const evidence: RevisionObjectStateEvidence[] = [];
  for (const sentence of sentencesIn(content)) {
    // 否定只约束它所在的分句：“没有执行逮捕，而是撬毁压制环”仍必须记录撬毁；
    // “并未撬毁压制环”则不建立终止状态。复杂无标点句宁可留给全文语义复核。
    const hasAffirmedObjectState = sentence.value
      .split(/[，,；;：:]/u)
      .some(clause => (
        !/(?:未能|并未|没有|尚未|未曾|从未)/u.test(clause)
        && objectStateFromText(clause) !== null
        && objectNames.some(name => objectMentionMatches(clause, name))
      ));
    if (!hasAffirmedObjectState) continue;
    evidence.push({ statement: sentence.value.trim(), temporalScope });
  }
  return evidence;
}

/** 用完整规范名及其中至少两个字的姓名段做逐字命中，不做模糊语义猜测。 */
export function knownPersonNamesMentioned(
  content: string,
  names: readonly string[],
): string[] {
  const normalized = normalize(content);
  return [...new Set(names.map(name => name.trim()).filter(Boolean))].filter(name =>
    personNameForms(name).some(form => normalized.includes(normalize(form))));
}

interface ExplicitAgeMention {
  age: number;
  start: number;
  end: number;
  nameForm: string;
}

function explicitAgeMentionsForPerson(content: string, name: string): ExplicitAgeMention[] {
  const mentions: ExplicitAgeMention[] = [];
  for (const form of personNameForms(name)) {
    const escaped = escapeRegExp(form);
    const patterns = [
      new RegExp(`(?:年仅|时年|当时|那时|此时)?\\s*(${AGE_NUMBER})\\s*岁(?:的)?\\s*${escaped}`, 'gu'),
      new RegExp(`${escaped}[^。！？!?；;\\n]{0,12}?(?:年仅|时年|当时年龄为|年龄为|已经|已)?\\s*(${AGE_NUMBER})\\s*岁`, 'gu'),
    ];
    for (const pattern of patterns) {
      for (const match of content.matchAll(pattern)) {
        const age = parseNumber(match[1] ?? '');
        if (age === null || age > 20_000 || match.index === undefined) continue;
        // 只看本次命中的短语本身，避免上一句偶然出现“外貌”二字就把真正错龄放过。
        if (APPEARANCE_AGE_MARKERS.test(match[0])) continue;
        mentions.push({
          age,
          start: match.index,
          end: match.index + match[0].length,
          nameForm: form,
        });
      }
    }
  }
  const bySpan = new Map<string, ExplicitAgeMention>();
  for (const mention of mentions) {
    const key = `${mention.start}:${mention.end}`;
    const previous = bySpan.get(key);
    if (!previous || mention.nameForm.length > previous.nameForm.length) bySpan.set(key, mention);
  }
  return [...bySpan.values()];
}

type TerminalObjectState = 'destroyed' | 'lost' | 'sealed';

interface TerminalObjectConstraint {
  name: string;
  era: string;
  year: number;
}

const DESTROYED_OBJECT = /撬毁|摧毁|毁坏|损毁|焚毁|烧毁|击碎|砸毁|崩解|碎裂|断裂|破坏|销毁|报废/u;
const LOST_OBJECT = /遗失|丢失|失窃|被夺|失去踪迹|下落不明|彻底消失/u;
const SEALED_OBJECT = /封存|封印|收缴|扣押|锁入/u;
const RESTORED_OBJECT = /修复|复原|找回|寻回|追回|解除封存|解封|重制|替换|替代/u;
const OBJECT_REMAINS = /残片|碎片|断片|残骸|遗痕|勒痕|空位|残留|遗址|拓片|照片|记录|复制品|仿制品|替代品|重制品/u;
const OBJECT_ACTIVE_USE = /佩戴|戴着|戴上|扣着|扣上|握着|拿着|携带|随身|藏着|藏在|收在|带在|系在|贴在|别在|调整|修理|使用|启动|把玩|抚摸|摩挲|触碰|显露|露出|若隐若现|仍在|依然|完好|摆在|放在|置于|挂在|套在|遮住|掩住|衣下|领下|内侧|颈部|手中|怀中/u;

function collectTerminalObjectConstraints(
  objectNames: readonly string[],
  passageTime: PassageTimeWindow,
  evidence: readonly RevisionObjectStateEvidence[],
): TerminalObjectConstraint[] {
  if (
    !passageTime.era
    || passageTime.startYear === null
    || passageTime.endYear === null
  ) return [];
  const constraints: TerminalObjectConstraint[] = [];
  for (const name of [...new Set(objectNames.map(value => value.trim()).filter(Boolean))]) {
    const events: Array<{
      state: TerminalObjectState | 'restored';
      era: string;
      year: number;
    }> = [];
    for (const item of evidence) {
      const combined = `${item.temporalScope ?? ''} ${item.statement}`.trim();
      if (!objectMentionMatches(combined, name)) continue;
      const time = parseYearPoint(item.temporalScope ?? item.statement);
      if (!time.era || time.era !== passageTime.era || time.year === null) continue;
      const state = objectStateFromText(item.statement);
      if (state) events.push({ state, era: time.era, year: time.year });
    }
    if (events.length === 0) continue;
    const latestYear = Math.max(...events.map(event => event.year));
    const latest = events.filter(event => event.year === latestYear);
    // 同年同时出现恢复/替换与终止状态时，顺序不明；按 fail-open 放过。
    if (latest.some(event => event.state === 'restored')) continue;
    const terminal = latest.find((event): event is typeof event & { state: TerminalObjectState } =>
      event.state !== 'restored');
    if (!terminal || passageTime.startYear <= terminal.year) continue;
    constraints.push({
      name,
      era: terminal.era,
      year: terminal.year,
    });
  }
  return constraints;
}

function objectStateFromText(value: string): TerminalObjectState | 'restored' | null {
  if (RESTORED_OBJECT.test(value)) return 'restored';
  if (DESTROYED_OBJECT.test(value)) return 'destroyed';
  if (LOST_OBJECT.test(value)) return 'lost';
  if (SEALED_OBJECT.test(value)) return 'sealed';
  return null;
}

function objectMentionMatches(content: string, name: string): boolean {
  const normalizedContent = normalizeObjectName(content);
  const normalizedName = normalizeObjectName(name);
  if (normalizedName.length < 3) return false;
  if (normalizedContent.includes(normalizedName)) return true;
  const suffix = Array.from(normalizedName).slice(-3).join('');
  return suffix.length >= 3 && normalizedContent.includes(suffix);
}

function conflictingObjectSentences(
  content: string,
  name: string,
): Array<{ start: number; end: number }> {
  const output: Array<{ start: number; end: number }> = [];
  for (const sentence of sentencesIn(content)) {
    if (!objectMentionMatches(sentence.value, name)) continue;
    if (OBJECT_REMAINS.test(sentence.value) || RESTORED_OBJECT.test(sentence.value)) continue;
    if (!OBJECT_ACTIVE_USE.test(sentence.value)) continue;
    output.push({ start: sentence.start, end: sentence.end });
  }
  return output;
}

function sentencesIn(content: string): Array<{ value: string; start: number; end: number }> {
  const output: Array<{ value: string; start: number; end: number }> = [];
  const pattern = /[^。！？!?\n]+[。！？!?]?/gu;
  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined) continue;
    output.push({
      value: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return output;
}

function parseYearPoint(value: string): { era: string | null; year: number | null } {
  const match = value.match(/([\p{Script=Han}]{2,8}纪元)\s*([0-9零〇一二两三四五六七八九十百千]{1,8})\s*年/u);
  if (!match) return { era: null, year: null };
  return { era: match[1] ?? null, year: parseNumber(match[2] ?? '') };
}

function applyEdits(
  content: string,
  edits: ReadonlyArray<{ start: number; end: number; replacement: string; name: string }>,
): ProseSoftReviewResult {
  if (edits.length === 0) return { content, correctedNames: [] };
  const accepted: typeof edits[number][] = [];
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    if (accepted.some(item => edit.start < item.end && edit.end > item.start)) continue;
    accepted.push(edit);
  }
  let output = content;
  for (const edit of accepted) {
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
  }
  return {
    content: output.replace(/\s{2,}/gu, ' ').trim(),
    correctedNames: [...new Set(accepted.map(edit => edit.name))],
  };
}

function personNameForms(name: string): string[] {
  const forms = [name, ...name.split(/[·・]/u)]
    .map(value => value.trim())
    .filter(value => Array.from(value).length >= 2);
  return [...new Set(forms)];
}

function parseNumber(value: string): number | null {
  if (/^[0-9]+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const digits: Record<string, number> = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (!/[十百千]/u.test(value)) {
    let output = 0;
    for (const character of value) {
      const digit = digits[character];
      if (digit === undefined) return null;
      output = output * 10 + digit;
    }
    return output;
  }
  let total = 0;
  let current = 0;
  for (const character of value) {
    if (character in digits) {
      current = digits[character]!;
      continue;
    }
    const unit = character === '十' ? 10 : character === '百' ? 100 : character === '千' ? 1_000 : 0;
    if (unit === 0) return null;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function normalizeObjectName(value: string): string {
  return value.normalize('NFKC').replace(/[\s·・._—–\-「」『』“”'‘’()（）【】\[\]，。！？；：、]+/gu, '')
    .toLocaleLowerCase('zh-CN');
}
