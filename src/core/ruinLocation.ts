const LOCATION_SEPARATOR = /\s*[-－—–]\s*/u;

export const MVU_LOCATION_MIN_LEVELS = 4;
export const MVU_LOCATION_MAX_LEVELS = 8;

/**
 * 角色卡核心地点合同：从大到小保留 4～8 层，以半角连字符连接。
 * 玩家输入不受此约束；只有生成后的节点地点与实际入境写回必须满足。
 */
export function splitMvuLocation(value: string): string[] {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .split(LOCATION_SEPARATOR)
    .map(part => part.trim())
    .filter(Boolean);
}

export function normalizeMvuLocation(value: string): string {
  return splitMvuLocation(value).join('-');
}

export function isValidMvuLocation(value: string): boolean {
  const levels = splitMvuLocation(value);
  return levels.length >= MVU_LOCATION_MIN_LEVELS
    && levels.length <= MVU_LOCATION_MAX_LEVELS;
}

/**
 * 新候选应直接携带完整地点；这里仅为旧候选提供安全兼容：
 * 若玩家当时填写的是完整父级路径，而节点只写了末端房间/街道，则合并去重。
 * 两边都只有简称时不伪造大陆、势力或聚落，而是阻止无效地点写进 MVU。
 */
export function resolveRuinEntryLocation(
  nodeLocation: string,
  requestedLocation: string,
): string {
  const node = splitMvuLocation(nodeLocation);
  if (node.length >= MVU_LOCATION_MIN_LEVELS && node.length <= MVU_LOCATION_MAX_LEVELS) {
    return node.join('-');
  }

  const requested = splitMvuLocation(requestedLocation);
  if (requested.length >= MVU_LOCATION_MIN_LEVELS) {
    const combined = [...requested];
    for (const part of node) {
      if (combined.at(-1) !== part && !combined.includes(part)) combined.push(part);
    }
    if (combined.length >= MVU_LOCATION_MIN_LEVELS && combined.length <= MVU_LOCATION_MAX_LEVELS) {
      return combined.join('-');
    }
  }

  throw new Error(
    `该候选的入境地点只有 ${node.length || requested.length} 层，无法安全写入角色卡要求的 4～8 层地点路径；请重新生成这份墟境候选。`,
  );
}
