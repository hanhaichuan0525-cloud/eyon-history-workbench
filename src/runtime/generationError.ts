/**
 * 生成层标准错误码信封（single source of truth）。
 *
 * 目标：把「一个错误属于哪一类」从「人读 message 猜」变成「机器读 kind/code 分支」。
 * 同一份 code 贯穿 校验 → 重试判定 → 退避计算 → UI 错误日志，三类问题
 * （校验漂移 / 环境抖动 / 临时故障）在入口就分开，不再相互污染。
 *
 * 设计原则：
 * - 不删除任何既有 message 文案（用户可见内容不变，避免破坏规则/卡片依赖）。
 * - kind 是「动作分类」：validation（走 repair）、retryable（可重试）、permanent（不重试直接报）。
 * - code 是「机器分类」：校验用现有 code（PLAN_SCHEMA_INVALID 等）原样透传；
 *   网络/超时/截断用精确 code（UPSTREAM_502 / TIMEOUT / TRUNCATED / ...）。
 * - 兼容：BiographyValidationError 保留 code 字段并加 kind；CustomApiRequestError
 *   在进入生成层时映射为信封；其余 Error 用 codeFromErrorMessage 兜底归类（唯一保留
 *   message 判定的地方，避免外部无 code 错误无法分类）。
 */

export type GenerationFailureKind = 'validation' | 'retryable' | 'permanent';

export const GENERATION_ERROR_CODES = {
  // —— 校验错误（validation；走 repair 回路，永远不重试网络）——
  VALIDATION: 'VALIDATION',
  // —— 上游临时故障（retryable；首错立即重试 + 指数退避）——
  UPSTREAM_BAD_GATEWAY: 'UPSTREAM_BAD_GATEWAY',
  UPSTREAM_GATEWAY_TIMEOUT: 'UPSTREAM_GATEWAY_TIMEOUT',
  UPSTREAM_SERVICE_UNAVAILABLE: 'UPSTREAM_SERVICE_UNAVAILABLE',
  UPSTREAM_TOO_MANY_REQUESTS: 'UPSTREAM_TOO_MANY_REQUESTS',
  UPSTREAM_INTERNAL_ERROR: 'UPSTREAM_INTERNAL_ERROR',
  PREMATURE_CLOSE: 'PREMATURE_CLOSE',
  NETWORK_RESET: 'NETWORK_RESET',
  NETWORK_FAILED: 'NETWORK_FAILED',
  // —— 超时（retryable；只重试 1 次即上抛，避免无声空转）——
  TIMEOUT: 'TIMEOUT',
  // —— 截断 / 畸形 JSON（retryable；顶格重试 1 次 → 降级单块）——
  TRUNCATED: 'TRUNCATED',
  // —— 空响应（retryable）——
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',
  // —— 永不可重试（permanent）——
  AUTH_FAILED: 'AUTH_FAILED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  API_ERROR: 'API_ERROR',
  // —— 未归类的透传错误（默认按内容尽力分类，最坏 permanent 直接报）——
  UNKNOWN: 'UNKNOWN',
} as const;

export type GenerationErrorCode =
  (typeof GENERATION_ERROR_CODES)[keyof typeof GENERATION_ERROR_CODES];

export interface GenerationFailureEnvelope {
  kind: GenerationFailureKind;
  code: GenerationErrorCode;
  message: string;
  /** 额外诊断上下文（可选）：当前 span、重试次数、上游端点、原始 status 等 */
  context?: Record<string, unknown>;
}

/** CustomApiRequestError 的结构化窥探（避免硬依赖其类定义；有 status/kind 即视为它）。 */
interface CustomApiErrorLike {
  status?: number | null;
  kind?: string;
  retryAfterMs?: number | null;
}

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function codeForHttpStatus(status: number): GenerationErrorCode {
  switch (status) {
    case 408:
    case 504:
      return GENERATION_ERROR_CODES.UPSTREAM_GATEWAY_TIMEOUT;
    case 429:
      return GENERATION_ERROR_CODES.UPSTREAM_TOO_MANY_REQUESTS;
    case 500:
      return GENERATION_ERROR_CODES.UPSTREAM_INTERNAL_ERROR;
    case 502:
      return GENERATION_ERROR_CODES.UPSTREAM_BAD_GATEWAY;
    case 503:
      return GENERATION_ERROR_CODES.UPSTREAM_SERVICE_UNAVAILABLE;
    default:
      return GENERATION_ERROR_CODES.UPSTREAM_INTERNAL_ERROR;
  }
}

/**
 * 把任意 error 归一到信封。
 * - 信封/校验错误 → 原样（保留其 code 与 kind）。
 * - CustomApiRequestError → 按 kind/status 映射精确 code。
 * - 其他 Error → 用 message 兜底归类。这是唯一保留 message 判定的地方。
 */
export function toGenerationFailureEnvelope(
  error: unknown,
): GenerationFailureEnvelope {
  if (error instanceof Error && 'kind' in error) {
    const envelope = error as unknown as GenerationFailureEnvelope;
    if (
      (envelope.kind === 'validation' || envelope.kind === 'retryable' || envelope.kind === 'permanent')
      && typeof envelope.code === 'string'
      && typeof envelope.message === 'string'
    ) {
      return envelope;
    }
  }

  if (error instanceof Error && 'code' in error && (error as { code?: unknown }).code !== undefined) {
    // BiographyValidationError 等带 code 的校验错误 → validation
    return {
      kind: 'validation',
      code: GENERATION_ERROR_CODES.VALIDATION,
      message: error.message,
    };
  }

  const raw = error instanceof Error ? error : new Error(String(error));
  const message = raw.message;
  const context = error instanceof Error ? { cause: error } : undefined;

  // CustomApiRequestError（tavernRuntimeAdapter）显式映射：优先按 status/kind 精确归类，
  // 避免依赖 message 正则（Bad Gateway 从 HTTP 502 精确归类，而不是靠文本猜）。
  if (error instanceof Error && ('status' in error || 'kind' in error)) {
    const typed = error as Error & CustomApiErrorLike;
    const hasStatus = typeof typed.status === 'number' && Number.isInteger(typed.status);
    const kind = typeof typed.kind === 'string' ? typed.kind : undefined;
    let code: GenerationErrorCode = GENERATION_ERROR_CODES.UNKNOWN;
    if (hasStatus && RETRYABLE_HTTP_STATUS.has(typed.status!)) {
      code = codeForHttpStatus(typed.status!);
    } else if (kind === 'transport' && /timed out after|timeout/iu.test(message)) {
      code = GENERATION_ERROR_CODES.TIMEOUT;
    } else if (kind === 'transport' && isRelayPlaceholderMessage(message)) {
      // 中转站占位错误（<none>/空消息/{} /null）：上游异常但无具体信息，
      // 属瞬时故障（对齐 tavernRuntimeAdapter.isRelayPlaceholderError），走可重试路径。
      code = GENERATION_ERROR_CODES.EMPTY_RESPONSE;
    } else if (kind === 'transport' && /closed prematurely|premature close|err_stream_premature_close/iu.test(message)) {
      code = GENERATION_ERROR_CODES.PREMATURE_CLOSE;
    } else if (kind === 'transport' && /ECONNRESET|ECONNREFUSED|socket hang up/iu.test(message)) {
      code = GENERATION_ERROR_CODES.NETWORK_RESET;
    } else if (kind === 'transport') {
      // 适配器已经把这类异常明确标记为 transport。即使上游换了错误文案，
      // 也应沿用生成层现有的有限重试，而不是因文本未命中而误判为永久错误。
      code = GENERATION_ERROR_CODES.NETWORK_FAILED;
    } else if (kind === 'empty_response' || /response is empty/iu.test(message) || isRelayPlaceholderMessage(message)) {
      code = GENERATION_ERROR_CODES.EMPTY_RESPONSE;
    } else if (kind === 'provider_http') {
      code = codeFromErrorMessage(message);
    } else {
      code = codeFromErrorMessage(message);
    }
    return { kind: generationKind(code), code, message, context };
  }

  const code = codeFromErrorMessage(message);
  const kind = kindForCode(code, message);
  return { kind, code, message, context };
}

/** 中转站占位错误归一化判定（对齐 tavernRuntimeAdapter.isRelayPlaceholderError）。 */
function isRelayPlaceholderMessage(message: string): boolean {
  const normalized = message
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .toLocaleLowerCase();
  if (isRawRelayPlaceholder(normalized)) return true;

  // tavernRuntimeAdapter 会把裸占位值包装成完整的诊断句再抛出；分类器必须
  // 读取冒号后的 payload，而不能只和裸 `<none>` 比较。
  const wrapperPrefix = 'customapirelayreturnedaplaceholdererror:';
  return normalized.startsWith(wrapperPrefix)
    && isRawRelayPlaceholder(normalized.slice(wrapperPrefix.length));
}

function isRawRelayPlaceholder(value: string): boolean {
  return value === ''
    || value === '<none>'
    || value === 'none'
    || value === '{}'
    || value === 'null';
}

/** 由错误码返回 action 分类。 */
export function generationKind(code: string): GenerationFailureKind {
  switch (code) {
    case GENERATION_ERROR_CODES.TIMEOUT:
    case GENERATION_ERROR_CODES.UPSTREAM_BAD_GATEWAY:
    case GENERATION_ERROR_CODES.UPSTREAM_GATEWAY_TIMEOUT:
    case GENERATION_ERROR_CODES.UPSTREAM_SERVICE_UNAVAILABLE:
    case GENERATION_ERROR_CODES.UPSTREAM_TOO_MANY_REQUESTS:
    case GENERATION_ERROR_CODES.UPSTREAM_INTERNAL_ERROR:
    case GENERATION_ERROR_CODES.PREMATURE_CLOSE:
    case GENERATION_ERROR_CODES.NETWORK_RESET:
    case GENERATION_ERROR_CODES.NETWORK_FAILED:
    case GENERATION_ERROR_CODES.TRUNCATED:
    case GENERATION_ERROR_CODES.EMPTY_RESPONSE:
      return 'retryable';
    case GENERATION_ERROR_CODES.AUTH_FAILED:
    case GENERATION_ERROR_CODES.QUOTA_EXCEEDED:
    case GENERATION_ERROR_CODES.API_ERROR:
      return 'permanent';
    case GENERATION_ERROR_CODES.VALIDATION:
      return 'validation';
    default:
      return 'permanent';
  }
}

const MESSAGE_PATTERNS: Array<[RegExp, GenerationErrorCode]> = [
  [/timed out after|timed out|timeout/iu, GENERATION_ERROR_CODES.TIMEOUT],
  [/bad gateway|\b502\b/iu, GENERATION_ERROR_CODES.UPSTREAM_BAD_GATEWAY],
  [/gateway timeout|\b504\b/iu, GENERATION_ERROR_CODES.UPSTREAM_GATEWAY_TIMEOUT],
  [/service unavailable|\b503\b/iu, GENERATION_ERROR_CODES.UPSTREAM_SERVICE_UNAVAILABLE],
  [/too many requests|\b429\b/iu, GENERATION_ERROR_CODES.UPSTREAM_TOO_MANY_REQUESTS],
  [/internal server error|\b500\b/iu, GENERATION_ERROR_CODES.UPSTREAM_INTERNAL_ERROR],
  [/closed prematurely|premature close|err_stream_premature_close|stream (?:was )?closed prematurely/iu, GENERATION_ERROR_CODES.PREMATURE_CLOSE],
  [/ECONNRESET|ECONNREFUSED|socket hang up/iu, GENERATION_ERROR_CODES.NETWORK_RESET],
  [/network|fetch failed/iu, GENERATION_ERROR_CODES.NETWORK_FAILED],
  [/response was truncated|incomplete json|finish_reason=(?:length|max_tokens)/iu, GENERATION_ERROR_CODES.TRUNCATED],
  [/response is empty|empty.*response/iu, GENERATION_ERROR_CODES.EMPTY_RESPONSE],
  [/\b401\b|unauthori[sz]ed|invalid (?:api )?key|authentication (?:failed|error)|鉴权失败|未授权/iu, GENERATION_ERROR_CODES.AUTH_FAILED],
  [/insufficient_quota|\b429\b.*quota|quota/iu, GENERATION_ERROR_CODES.QUOTA_EXCEEDED],
];

function codeFromErrorMessage(message: string): GenerationErrorCode {
  for (const [pattern, code] of MESSAGE_PATTERNS) {
    if (pattern.test(message)) return code;
  }
  return GENERATION_ERROR_CODES.UNKNOWN;
}

function kindForCode(
  code: GenerationErrorCode,
  message: string,
): GenerationFailureKind {
  const kind = generationKind(code);
  if (kind !== 'validation' && kind !== 'permanent') return kind;
  // UNKNOWN 但有诱发重试内容的文本（我们的 message 兜底）仍给 retryable 机会，
  // 与既有「可重试文本」行为一致；真正的 unknown 直接 permanent。
  if (code === GENERATION_ERROR_CODES.UNKNOWN) {
    return /(?:bad gateway|timeout|network|fetch failed|ECONNRESET|socket hang up)/iu.test(message)
      ? 'retryable'
      : 'permanent';
  }
  return kind;
}
