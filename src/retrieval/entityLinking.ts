/**
 * internal.82 实体归并（F-01 修复）：把蝴蝶结算的模型命名实体（carrier）
 * 保守映射回冻结检索的稳定 catalog 实体 id，使干涉事实与史料实体同空间，
 * 从而能被后续任务的 canon 当前视图命中（见 docs/F01-蝴蝶干涉实体归并方案）。
 *
 * 纪律（红线：不猜）：
 * - 只做名字层确定性匹配：归一化完全相等，或 ≥2 字双向包含（personNameMatches 同款语义）；
 * - 多候选命中一律不映射（返回 null → 调用方维持 entity:generated 兜底），宁漏勿错；
 * - 匹配源只用 canonicalName + aliases（不用身份短语/职业等易噪声字段）；
 * - 纯函数、无 I/O、无模型、无网络。
 */

export interface EntityLinkCandidate {
  entityId: string;
  names: string[];
}

export interface EntityLinkNameSource {
  entityId: string;
  names: readonly string[];
}

function normalizeEntityName(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

/**
 * 由冻结检索的角色编排与人物视图构建去重映射索引（有界：最多 200 候选、
 * 每候选最多 12 个别名；超出部分丢弃，宁缺勿错）。
 */
export function buildEntityLinkingIndex(
  sources: readonly EntityLinkNameSource[],
  limit = 200,
): EntityLinkCandidate[] {
  const byId = new Map<string, Set<string>>();
  for (const source of sources) {
    if (byId.size >= limit) break;
    const names = new Set<string>();
    for (const raw of source.names) {
      if (names.size >= 12) break;
      const name = normalizeEntityName(raw);
      if (name && name.length >= 2) names.add(name);
    }
    if (names.size === 0) continue;
    const existing = byId.get(source.entityId);
    if (existing) {
      for (const name of names) existing.add(name);
    } else if (byId.size < limit) {
      byId.set(source.entityId, names);
    }
  }
  return [...byId.entries()].map(([entityId, names]) => ({
    entityId,
    names: [...names],
  }));
}

function nameMatchesCarrier(name: string, carrier: string): boolean {
  const a = normalizeEntityName(name);
  const b = normalizeEntityName(carrier);
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= 2 && longer.includes(shorter);
}

/**
 * 把模型输出的载体名映射到稳定实体 id。
 * - 命中唯一候选 → 返回其 entityId；
 * - 无命中或多候选命中（复合描述/重名，无法确定）→ null（调用方用 generated 兜底）。
 */
export function linkCarrier(
  carrier: string,
  index: readonly EntityLinkCandidate[],
): string | null {
  const normalized = normalizeEntityName(carrier);
  if (!normalized || normalized.length < 2) return null;
  const hits = new Set<string>();
  for (const candidate of index ?? []) {
    if (candidate.names.some(name => nameMatchesCarrier(name, normalized))) {
      hits.add(candidate.entityId);
      if (hits.size > 1) return null;
    }
  }
  return hits.size === 1 ? [...hits][0]! : null;
}
