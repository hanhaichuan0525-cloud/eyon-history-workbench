const FORBIDDEN_ROOT_TRACE_CONTENT = [
  '<item_info>',
  '[RuinTrace]',
  '<butterfly_panel>',
  '<UpdateVariable>',
];

export function validateRootTrace(raw: string): string {
  const normalized = raw.replace(/\r\n?/gu, '\n').trim();

  if (!normalized.startsWith('[RootTrace]\n')) {
    throw new Error('RootTrace must start with [RootTrace]');
  }
  if (!normalized.endsWith('\n[/RootTrace]')) {
    throw new Error('RootTrace must end with [/RootTrace]');
  }
  if (FORBIDDEN_ROOT_TRACE_CONTENT.some(token => normalized.includes(token))) {
    throw new Error('RootTrace contains content owned by another workflow');
  }
  if (/<details\b[^>]*\bopen(?:\s|=|>)/iu.test(normalized)) {
    throw new Error('RootTrace details must be collapsed by default');
  }

  return normalized;
}
