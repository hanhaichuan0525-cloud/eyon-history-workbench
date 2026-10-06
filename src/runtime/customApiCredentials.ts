export function normalizeCustomApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, '');
  return trimmed.replace(/\/(?:chat\/completions|models)$/iu, '');
}

export function requireCustomApiBaseUrl(value: string, module = '当前生成模块'): string {
  const endpoint = normalizeCustomApiBaseUrl(value);
  if (!endpoint) {
    throw new Error(
      `「${module}」实际读取的独立 API 地址为空。请在设置 → API调用中选择该模块，重新填写地址并点击「保存当前模块」或「应用到全部模块」；若界面已有地址，请核对保存的模块及是否重复载入脚本。本次请求未发送。`,
    );
  }
  return endpoint;
}

export function normalizeCustomApiKey(value: string | undefined): string {
  let normalized = value?.trim() ?? '';
  if (
    normalized.length >= 2
    && ((normalized.startsWith('"') && normalized.endsWith('"'))
      || (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized.replace(/^(?:Bearer\s+)+/iu, '').trim();
}

export function requireCustomApiKey(value: string | undefined): string {
  const key = normalizeCustomApiKey(value);
  if (!key || /^(?:\*|•)+$/u.test(key)) {
    throw new Error(
      '独立 API 密钥为空。请在“设置 → API调用”中重新填写当前模块的密钥并保存；重新导入脚本后，密钥不会随安装包迁移。',
    );
  }
  return key;
}

export function customAuthorizationHeader(value: string | undefined): string {
  return `Authorization: Bearer ${requireCustomApiKey(value)}`;
}

export function customApiAuthenticationError(
  endpoint: string,
  model: string,
): Error {
  return new Error(
    `独立 API 鉴权失败（Unauthorized）。请重新填写并保存当前模块的密钥，再用“拉取列表”验证；若刚更新或重新导入脚本，需要重新填写密钥。接口：${endpoint}；模型：${model}`,
  );
}

export function isAuthenticationFailure(message: string): boolean {
  return /(?:\b401\b|unauthori[sz]ed|invalid\s+(?:api\s*)?key|authentication\s+(?:failed|error)|鉴权失败|未授权)/iu.test(
    message,
  );
}
