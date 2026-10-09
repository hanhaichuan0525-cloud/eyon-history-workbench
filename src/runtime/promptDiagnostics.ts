export type PromptDiagnosticTask = 'genealogy' | 'ruin' | 'biography' | 'butterfly';

export interface PromptDiagnostic {
  diagnosticId: number;
  recordedAt: number;
  taskType: PromptDiagnosticTask;
  stage: string;
  requestId: string | null;
  attempt: number;
  compactRecovery: boolean;
  promptChars: number;
  systemChars: number;
  totalChars: number;
  qualifiedEvidenceChars: number;
  /** 仅服务端实际返回的用量；缺失不估算。 */
  usage?: { provider: 'openai' | 'gemini'; input?: number; output?: number; total?: number; cached?: number };
  personCanonChars: number;
  passageEvidenceChars: number;
  taskAnchorAttachmentChars: number;
}

const MAX_PROMPT_DIAGNOSTICS = 64;
const diagnostics: PromptDiagnostic[] = [];
let diagnosticSequence = 0;

/**
 * 记录实际送入生成通道的字符预算，不保存 prompt 正文或证据正文。
 * 放在传输门前记录，因此重试与 compact recovery 也能如实出现。
 */
export function recordPromptDiagnostic(input: {
  taskType: PromptDiagnosticTask;
  prompt: string;
  systemPrompt: string;
  attempt: number;
  compactRecovery: boolean;
}): number {
  const diagnosticId = ++diagnosticSequence;
  diagnostics.push({
    diagnosticId,
    recordedAt: Date.now(),
    taskType: input.taskType,
    stage: detectStage(input.taskType, input.prompt),
    requestId: extractRequestId(input.prompt),
    attempt: input.attempt,
    compactRecovery: input.compactRecovery,
    promptChars: input.prompt.length,
    systemChars: input.systemPrompt.length,
    totalChars: input.prompt.length + input.systemPrompt.length,
    qualifiedEvidenceChars: taggedBlockChars(input.prompt, 'QUALIFIED_EVIDENCE_VIEW'),
    personCanonChars: taggedBlockChars(input.prompt, 'PERSON_CANON_VIEW'),
    passageEvidenceChars: taggedBlockChars(input.prompt, 'PASSAGE_EVIDENCE'),
    taskAnchorAttachmentChars: taggedBlockChars(input.prompt, 'TASK_ANCHOR_ATTACHMENT'),
  });
  if (diagnostics.length > MAX_PROMPT_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_PROMPT_DIAGNOSTICS);
  }
  return diagnosticId;
}

export function listPromptDiagnostics(): PromptDiagnostic[] {
  return structuredClone(diagnostics);
}

export function clearPromptDiagnostics(): void {
  diagnostics.splice(0, diagnostics.length);
}

// 测试兼容入口；清空后不重置序号，旧请求不会回写新聊天的诊断。
export const clearPromptDiagnosticsForTest = clearPromptDiagnostics;

export function recordPromptUsage(diagnosticId: number, response: unknown): void {
  const entry = diagnostics.find(item => item.diagnosticId === diagnosticId);
  if (!entry || !response || typeof response !== 'object') return;
  const root = response as Record<string, unknown>;
  const provider = root.usageMetadata ? 'gemini' : 'openai';
  const raw = root.usageMetadata ?? root.usage;
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  const count = (number: unknown) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
  const input = count(provider === 'gemini' ? value.promptTokenCount : value.prompt_tokens);
  const output = count(provider === 'gemini' ? value.candidatesTokenCount : value.completion_tokens);
  const total = count(provider === 'gemini' ? value.totalTokenCount : value.total_tokens);
  const details = value.prompt_tokens_details as Record<string, unknown> | undefined;
  const cached = count(provider === 'gemini' ? value.cachedContentTokenCount : details?.cached_tokens);
  if ([input, output, total, cached].every(item => item === undefined)) return;
  entry.usage = { provider, input, output, total, cached };
}

function extractRequestId(prompt: string): string | null {
  return prompt.match(/"requestId"\s*:\s*"([^"\\]+)"/u)?.[1]
    ?? prompt.match(/requestId\s+MUST\s+equal\s+"([^"\\]+)"/iu)?.[1]
    ?? null;
}

function detectStage(taskType: PromptDiagnosticTask, prompt: string): string {
  if (prompt.includes('<CANON_RECONCILE>')) {
    return prompt.includes('<CANON_RECONCILE_REPAIR>')
      ? 'canon-reconcile-repair'
      : 'canon-reconcile';
  }
  let stage: string = taskType;
  if (taskType === 'ruin') {
    if (prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_VERDICT>')) {
      stage = 'expansion-cutoff-verdict';
    } else if (prompt.includes('<RUIN_EARLIER_WINDOW_CUTOFF_REVIEW>')) {
      stage = 'expansion-cutoff-review';
    } else stage = prompt.includes('<RUIN_SELECTED_CANDIDATE_EXPANSION>')
      || /:expand:[^"\s]+/u.test(prompt)
      ? 'expansion'
      : 'outline';
  } else if (taskType === 'biography') {
    if (prompt.includes('<BIOGRAPHY_PASSAGE_BATCH_MANDATORY_OUTPUT_CONTRACT>')) {
      stage = 'passage-batch';
    } else if (prompt.includes('<BIOGRAPHY_PASSAGE_MANDATORY_OUTPUT_CONTRACT>')) {
      stage = 'passage';
    } else if (prompt.includes('<BIOGRAPHY_PLAN_MANDATORY_OUTPUT_CONTRACT>')) {
      stage = 'plan';
    }
    else stage = 'plan';
  }
  if (/\b(?:repair|rejected|regenerate)\b/iu.test(prompt)) stage += '-repair';
  return stage;
}

function taggedBlockChars(prompt: string, tag: string): number {
  const startToken = `<${tag}>`;
  const endToken = `</${tag}>`;
  const start = prompt.indexOf(startToken);
  if (start < 0) return 0;
  const end = prompt.indexOf(endToken, start + startToken.length);
  if (end < 0) return 0;
  return end + endToken.length - start;
}
