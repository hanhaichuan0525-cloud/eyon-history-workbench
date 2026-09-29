type GlobalRecord = Record<string, unknown>;

/**
 * 只用于工作台可见文本：把稳定存储中的 <user> 展开为当前酒馆玩家名。
 * 存储、Canon、提示词和聊天楼正文仍保留 <user>，避免把档案绑定死到某个姓名。
 */
export function resolveWorkbenchDisplayText(
  value: string,
  globalObject: GlobalRecord = globalThis as GlobalRecord,
): string {
  const normalized = value.replace(/玩家/gu, '<user>');
  const playerName = readCurrentPlayerName(globalObject);
  if (playerName) return normalized.replace(/<user>/giu, playerName);

  const substitute = findMacroSubstituter(globalObject);
  if (!substitute) return normalized;
  try {
    const expanded = substitute(normalized);
    return typeof expanded === 'string' && expanded.trim() ? expanded : normalized;
  } catch {
    return normalized;
  }
}

function readCurrentPlayerName(globalObject: GlobalRecord): string {
  for (const candidate of collectGlobalCandidates(globalObject)) {
    const sillyTavern = asRecord(candidate.SillyTavern);
    const getContext = sillyTavern && typeof sillyTavern.getContext === 'function'
      ? sillyTavern.getContext as () => unknown
      : null;
    try {
      const context = asRecord(getContext?.call(sillyTavern));
      const name = typeof context?.name1 === 'string' ? context.name1.trim() : '';
      if (name) return name;
    } catch {
      // 跨窗体或宿主尚未就绪时继续寻找下一候选。
    }
    const legacyName = typeof candidate.name1 === 'string'
      ? candidate.name1.trim()
      : '';
    if (legacyName) return legacyName;
  }
  return '';
}

function findMacroSubstituter(
  globalObject: GlobalRecord,
): ((text: string) => string) | null {
  for (const candidate of collectGlobalCandidates(globalObject)) {
    const direct = candidate.substitudeMacros;
    if (typeof direct === 'function') {
      return direct as (text: string) => string;
    }
    const helper = asRecord(candidate.TavernHelper);
    const nested = helper?.substitudeMacros;
    if (typeof nested === 'function') {
      return nested as (text: string) => string;
    }
  }
  return null;
}

function collectGlobalCandidates(globalObject: GlobalRecord): GlobalRecord[] {
  const result: GlobalRecord[] = [];
  const append = (value: unknown): void => {
    const record = asRecord(value);
    if (record && !result.includes(record)) result.push(record);
  };
  append(globalObject);
  try {
    append(globalObject.parent);
  } catch {
    // cross-origin parent
  }
  try {
    append(globalObject.top);
  } catch {
    // cross-origin top
  }
  return result;
}

function asRecord(value: unknown): GlobalRecord | null {
  return value !== null && typeof value === 'object'
    ? value as GlobalRecord
    : null;
}
