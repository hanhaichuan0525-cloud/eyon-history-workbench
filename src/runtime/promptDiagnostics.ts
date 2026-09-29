export type PromptDiagnosticTask = 'genealogy' | 'ruin' | 'biography' | 'butterfly';

export interface PromptDiagnostic {
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
  semanticEvidenceChars: number;
  personCanonChars: number;
  passageEvidenceChars: number;
  taskAnchorAttachmentChars: number;
}

const MAX_PROMPT_DIAGNOSTICS = 64;
const diagnostics: PromptDiagnostic[] = [];

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
}): void {
  diagnostics.push({
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
    semanticEvidenceChars: taggedBlockChars(input.prompt, 'SEMANTIC_EVIDENCE_VIEW')
      || taggedBlockChars(input.prompt, 'SEMANTIC_EVIDENCE_COMPILER'),
    personCanonChars: taggedBlockChars(input.prompt, 'PERSON_CANON_VIEW'),
    passageEvidenceChars: taggedBlockChars(input.prompt, 'PASSAGE_EVIDENCE'),
    taskAnchorAttachmentChars: taggedBlockChars(input.prompt, 'TASK_ANCHOR_ATTACHMENT'),
  });
  if (diagnostics.length > MAX_PROMPT_DIAGNOSTICS) {
    diagnostics.splice(0, diagnostics.length - MAX_PROMPT_DIAGNOSTICS);
  }
}

export function listPromptDiagnostics(): PromptDiagnostic[] {
  return structuredClone(diagnostics);
}

export function clearPromptDiagnosticsForTest(): void {
  diagnostics.splice(0, diagnostics.length);
}

function extractRequestId(prompt: string): string | null {
  return prompt.match(/"requestId"\s*:\s*"([^"\\]+)"/u)?.[1]
    ?? prompt.match(/requestId\s+MUST\s+equal\s+"([^"\\]+)"/iu)?.[1]
    ?? null;
}

function detectStage(taskType: PromptDiagnosticTask, prompt: string): string {
  if (prompt.includes('<SEMANTIC_EVIDENCE_COMPILER>')) return 'semantic-evidence';
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
