export interface WorkbenchNamespace {
  characterKey: string;
  chatId: string;
}

function requirePart(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${name} must not be empty`);
  }
  return encodeURIComponent(normalized);
}

export function namespaceKey(namespace: WorkbenchNamespace): string {
  const characterKey = requirePart('characterKey', namespace.characterKey);
  const chatId = requirePart('chatId', namespace.chatId);
  return `${characterKey}::${chatId}`;
}

export function recordKey(
  namespace: WorkbenchNamespace,
  kind: string,
  id: string,
): string {
  const normalizedKind = requirePart('kind', kind);
  const normalizedId = requirePart('id', id);
  return `${namespaceKey(namespace)}::${normalizedKind}::${normalizedId}`;
}
