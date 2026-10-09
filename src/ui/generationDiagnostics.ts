import type { RuntimeShadowObservation } from '../retrieval/runtimeShadow.ts';
import type { PromptDiagnostic } from '../runtime/promptDiagnostics.ts';

/** 只渲染既有回执和数值，不再检索、不发送额外模型请求。 */
export function renderGenerationDiagnostics(observations: RuntimeShadowObservation[], prompts: PromptDiagnostic[]): string {
  const latest = new Map<string, RuntimeShadowObservation>();
  for (const item of observations) latest.set(item.taskType, item);
  const receipts = [...latest.values()].map(item => {
    if (item.status !== 'success') return `<article><strong>${name(item.taskType)}</strong><p>最近检索失败，请查看错误日志。</p></article>`;
    const titles = new Map(item.sourceMappings.map(source => [source.snapshotId, source.title]));
    const decisions = (kind: 'selected' | 'rejected') => item.receipt[kind].map(decision =>
      `<li>${escape(titles.get(decision.snapshotId) ?? '未命名来源')} — ${escape(decision.reason)}</li>`).join('');
    return `<article><strong>${name(item.taskType)}</strong><p>命中 ${item.receipt.selected.length} 条／排除 ${item.receipt.rejected.length} 条；证据段 ${item.receipt.selectedPassages.length} 段，${item.receipt.passageBudget.usedChars} 字符</p>
      <details><summary>查看来源与筛选理由</summary><strong>入选</strong><ul>${decisions('selected') || '<li>无</li>'}</ul><strong>排除</strong><ul>${decisions('rejected') || '<li>无</li>'}</ul>
      ${item.receipt.warnings.map(warning => `<p>${escape(warning)}</p>`).join('')}</details></article>`;
  }).join('');
  const calls = prompts.slice(-8).reverse().map(item => {
    const usage = item.usage;
    const count = (value: number | undefined) => value === undefined ? '未返回' : String(value);
    return `<article><strong>${name(item.taskType)} / ${escape(item.stage)} / 第 ${item.attempt} 次请求</strong>
      <p>发送 ${item.totalChars} 字符（提示 ${item.promptChars}，系统 ${item.systemChars}）；合格证据 ${item.qualifiedEvidenceChars}，人物事实 ${item.personCanonChars}，段落证据 ${item.passageEvidenceChars}，人物附件 ${item.taskAnchorAttachmentChars} 字符</p>
      <p>${usage ? `服务端 token：输入 ${count(usage.input)}／输出 ${count(usage.output)}／总计 ${count(usage.total)}${usage.cached === undefined ? '' : `／缓存 ${usage.cached}`}` : '服务端未返回 token 用量；字符数不等于 token，未作估算。'}</p></article>`;
  }).join('');
  return `<section class="error-log request-diagnostic"><header><strong>检索与调用回执</strong><button class="quiet-button" type="button" data-action="refresh-request-diagnostics">刷新回执</button></header>
    <p>仅当前聊天的本次运行记录，不保存完整提示词、API 地址或密钥。</p>${receipts || '<p>尚无检索记录。</p>'}${calls || '<p>尚无调用记录。</p>'}</section>`;
}

function name(task: string): string { return ({ ruin: '墟境', biography: '传记', genealogy: '宗族', butterfly: '蝴蝶' } as Record<string, string>)[task] ?? escape(task); }
function escape(value: string): string { return value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
