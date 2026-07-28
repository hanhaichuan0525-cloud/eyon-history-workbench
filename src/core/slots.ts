export type SlotType = 'rootTrace' | 'ruinTrace';

const SLOT_PREFIX: Record<SlotType, string> = {
  rootTrace: 'EYON_ROOTTRACE_SLOT',
  ruinTrace: 'EYON_RUINTRACE_SLOT',
};

export function createSlot(type: SlotType, requestId: string): string {
  const normalizedId = requestId.trim();
  if (!/^[A-Za-z0-9._-]{1,96}$/u.test(normalizedId)) {
    throw new Error('requestId contains unsupported characters');
  }
  return `[${SLOT_PREFIX[type]}::${normalizedId}]`;
}
