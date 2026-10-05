import type { KnowledgeEntity, SourceSnapshot, WorldKnowledgeCatalog } from './contracts.ts';
import { entityTemporallyEligible, extractEraNames } from './temporal.ts';
import { templateIndependentText } from './sourceOwnership.ts';

// 称谓不是全局别名。只在本次查询中，用人物自己的身份/标题或具名职责证据消歧。
const ROLES = /女皇|皇帝|女王|国王|君主|统治者|领主|店长|校长|院长|会长|团长|司令|教皇|首相|总督/gu;
const norm = (value: string) => value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
const namesOf = (entity: KnowledgeEntity) => [entity.canonicalName, ...entity.aliases].filter(name => name.length >= 2);

export function resolveRoleReferences(query: string, catalog: WorldKnowledgeCatalog, snapshots: SourceSnapshot[]): {
  required: string[]; recommended: string[]; warnings: string[];
} {
  // 书名里的《女皇》是作品，不自动升级为该国君主。
  const roleQuery = query.replace(/《[^》]*》/gu, '');
  const roles = [...new Set(roleQuery.match(ROLES) ?? [])];
  const required: string[] = [], recommended: string[] = [], warnings: string[] = [];
  if (!roles.length) return { required, recommended, warnings };
  const normalizedQuery = norm(query);
  const eras = extractEraNames(query);
  const scopes = catalog.entities.filter(entity => !entity.kinds.includes('person')
    && !/^(?:大陆|全境|世界|地区|区域|国家|帝国|城市|主要城市)$/u.test(entity.canonicalName)
    && entity.kinds.some(kind => ['place', 'faction', 'organization'].includes(kind))
    && namesOf(entity).some(name => normalizedQuery.includes(norm(name))));
  const sources = snapshots.filter(source => source.sourceType === 'worldbook' || source.sourceType === 'mvu')
    .map(source => {
      const text = templateIndependentText(source.content);
      return { source, text, sentences: text.split(/[\r\n。！？；]/u).filter(sentence => roles.some(role => sentence.includes(role))) };
    });
  for (const role of roles) {
    const candidates: Array<{ entity: KnowledgeEntity; score: number }> = [];
    for (const entity of catalog.entities.filter(item => item.kinds.includes('person'))) {
      const personNames = namesOf(entity);
      const patterns = personNames.map(name => {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        return new RegExp(`(?:统治者|君主|店长|校长|院长|会长)\\s*[:：]\\s*${escaped}[^。；]{0,30}${role}|${role}\\s*${escaped}|${escaped}[^。；]{0,16}(?:是|担任|出任|作为|被称为)[^。；]{0,24}${role}|${escaped}[^。；]{0,16}${role}(?:[（(]|$)`, 'u');
      });
      const evidence = sources.filter(({ source, sentences }) => {
        const owns = entity.sourceSnapshotIds.includes(source.snapshotId);
        // 不把正文中碰巧提到另一位女皇，或功能指令中的称谓，当成本文主人身份。
        if (owns && (entity.identities.some(identity => identity.includes(role))
          || (source.title.includes(role) && personNames.some(name => source.title.includes(name))))) return true;
        return sentences.some(sentence => sentence.includes(role) && patterns.some(pattern => pattern.test(sentence)));
      });
      if (!evidence.length) continue;
      let score = 0;
      for (const scope of scopes) {
        const scopeNames = namesOf(scope);
        if (evidence.some(({ source, text }) => scopeNames.some(name =>
          source.title.includes(name) || text.includes(name)))) score += 1;
        // 例如帝国概览的“统治者: X女皇”，即使人物档案没有纪元/所属字段也可关联。
        if (evidence.some(({ source, sentences }) => scope.sourceSnapshotIds.includes(source.snapshotId)
          && sentences.some(sentence => sentence.includes(role)
            && personNames.some(name => sentence.includes(name))))) score += 2;
      }
      if (scopes.length && score === 0) continue;
      // 已知跨时代称谓不可直接绑定；仍召回原文作为只读候选，让模型解释缺失信息。
      const temporalConflict = eras.length === 1
        && !entityTemporallyEligible(entity, eras[0], catalog.temporalEligibility);
      candidates.push({ entity, score: temporalConflict ? -1 : score });
    }
    const eligible = candidates.filter(item => item.score >= 0);
    const best = Math.max(...eligible.map(item => item.score));
    const winners = eligible.filter(item => item.score === best);
    const relativeSubject = new RegExp(`${role}\\s*(?:的)?\\s*(?:父亲|母亲|祖父|祖母|曾祖|外祖|兄长|哥哥|姐姐|妹妹|弟弟|子女|儿子|女儿|伴侣|丈夫|妻子|老师|师父|家族|宗族|先祖|后裔)`, 'u').test(roleQuery);
    if (winners.length === 1 && !relativeSubject) required.push(winners[0].entity.entityId);
    else if (winners.length === 1) {
      recommended.push(winners[0].entity.entityId);
      warnings.push(`称谓“${role}”已关联${winners[0].entity.canonicalName}，但查询以其亲属或家族为主体；该人物仅作资料参照，不据此要求本人在场。`);
    }
    else {
      recommended.push(...(winners.length ? winners : candidates).map(item => item.entity.entityId));
      if (candidates.length) warnings.push(`称谓“${role}”尚不能唯一确定人物；只读召回候选原文，不得虚构替代该称谓的既定人物。`);
    }
  }
  return { required: [...new Set(required)], recommended: [...new Set(recommended)], warnings };
}
