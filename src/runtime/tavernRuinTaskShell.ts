import { namespaceKey } from '../core/namespace.ts';
import type { RuinTaskSnapshot } from '../adapters/host.ts';
import type { RuinTaskRecord } from '../schemas/ruinTask.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';
import { isLatestVisibleTurnPair } from './visibleTurns.ts';

const REQUEST_DATA_KEY = 'eyonHistoryRuinTaskRequest';
const RESULT_DATA_KEY = 'eyonHistoryRuinTaskResult';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

export interface RuinTaskFloorLock {
  requestId: string;
  runId: string;
  direction: string;
  task: RuinTaskRecord;
  contractText: string;
  approvedTaskHash: string;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  namespace: { characterKey: string; chatId: string };
  injection: 'fallback';
}

export interface RuinTaskTerminalCommit {
  namespace: { characterKey: string; chatId: string };
  runId: string;
  triggerMessageId: number;
  task: RuinTaskSnapshot;
}

export class TavernRuinTaskShellAdapter {
  private readonly runtime: TavernRuntime;

  constructor(runtime: TavernRuntime) {
    this.runtime = runtime;
  }

  async arm(lock: RuinTaskFloorLock): Promise<void> {
    // 使用可显式清理、也可在 regenerate/swipe 前重新武装的宿主注入通道。
    // once 注入无法可靠支撑“同一玩家楼重抽仍复用同一封缄任务”。
    await this.runtime.setExtensionPrompt(
      injectionKey(lock.requestId),
      lock.contractText,
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
  }

  async clear(lock: RuinTaskFloorLock): Promise<void> {
    await this.runtime.setExtensionPrompt(
      injectionKey(lock.requestId), '', IN_CHAT, INJECTION_DEPTH, false, ROLE_SYSTEM, null,
    );
  }

  async assertRenderedFloor(lock: RuinTaskFloorLock, assistantMessageId: number): Promise<void> {
    const current = currentNamespace(this.runtime);
    if (namespaceKey(current) !== namespaceKey(lock.namespace)) {
      throw new Error('Chat changed before ruin task narrative was rendered');
    }
    const trigger = requireMessage(this.runtime, lock.triggerMessageId);
    if (
      trigger.role !== 'user'
      || trigger.is_hidden
      || fingerprintText(trigger.message) !== lock.triggerTextHash
      || this.runtime.getMessageSwipeId(lock.triggerMessageId) !== lock.triggerSwipeId
    ) throw new Error('Ruin task trigger floor changed before commit');
    const assistant = requireMessage(this.runtime, assistantMessageId);
    if (
      assistant.role !== 'assistant'
      || assistant.is_hidden
      || !isLatestVisibleTurnPair(this.runtime, lock.triggerMessageId, assistantMessageId)
    ) throw new Error('Rendered assistant floor does not belong to the ruin task request');
  }

  async attachTriggerMetadata(lock: RuinTaskFloorLock): Promise<void> {
    const trigger = requireMessage(this.runtime, lock.triggerMessageId);
    await this.runtime.setChatMessages([{
      message_id: lock.triggerMessageId,
      message: trigger.message,
      extra: {
        ...(trigger.extra ?? {}),
        [REQUEST_DATA_KEY]: serializeLock(lock),
      },
    }], { refresh: 'none' });
  }

  readTriggerLock(messageId: number): RuinTaskFloorLock | null {
    const message = this.runtime.getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.role !== 'user' || message.is_hidden) return null;
    const raw = message.extra?.[REQUEST_DATA_KEY];
    if (!isRecord(raw) || raw.kind !== 'eyon.ruin-task.approved.v1') return null;
    if (!isRecord(raw.task) || !isRecord(raw.namespace)) return null;
    const requestId = textField(raw.requestId);
    const runId = textField(raw.runId);
    const direction = textField(raw.direction);
    const contractText = textField(raw.contractText);
    const approvedTaskHash = textField(raw.approvedTaskHash);
    const characterKey = textField(raw.namespace.characterKey);
    const chatId = textField(raw.namespace.chatId);
    if (!requestId || !runId || !direction || !contractText || !approvedTaskHash || !characterKey || !chatId) {
      return null;
    }
    const task = raw.task as unknown as RuinTaskRecord;
    if (!task.name || !task.value || !task.title || !task.mode || !task.difficulty) return null;
    return {
      requestId,
      runId,
      direction,
      task,
      contractText,
      approvedTaskHash,
      triggerMessageId: messageId,
      triggerTextHash: fingerprintText(message.message),
      triggerSwipeId: this.runtime.getMessageSwipeId(messageId),
      namespace: { characterKey, chatId },
      injection: 'fallback',
    };
  }

  async attachMetadata(lock: RuinTaskFloorLock, assistantMessageId: number): Promise<void> {
    const assistant = requireMessage(this.runtime, assistantMessageId);
    await this.runtime.setChatMessages([{
      message_id: assistantMessageId,
      message: assistant.message,
      extra: {
        ...(assistant.extra ?? {}),
        [REQUEST_DATA_KEY]: {
          requestId: lock.requestId,
          runId: lock.runId,
          direction: lock.direction,
          taskName: lock.task.name,
          approvedTaskHash: lock.approvedTaskHash,
          triggerMessageId: lock.triggerMessageId,
          swipeId: this.runtime.getMessageSwipeId(assistantMessageId),
        },
      },
    }], { refresh: 'none' });
  }

  readAssistantMessage(messageId: number): string {
    const message = requireMessage(this.runtime, messageId);
    if (message.role !== 'assistant' || message.is_hidden) {
      throw new Error(`Assistant message ${messageId} is unavailable`);
    }
    return message.message;
  }

  async appendTerminalPanel(
    commit: RuinTaskTerminalCommit,
    assistantMessageId: number,
    panel: string,
  ): Promise<void> {
    if (namespaceKey(currentNamespace(this.runtime)) !== namespaceKey(commit.namespace)) {
      throw new Error('Chat changed before ruin task result was rendered');
    }
    const assistant = requireMessage(this.runtime, assistantMessageId);
    if (
      assistant.role !== 'assistant'
      || assistant.is_hidden
      || !isLatestVisibleTurnPair(this.runtime, commit.triggerMessageId, assistantMessageId)
    ) throw new Error('Rendered assistant floor does not belong to the ruin task transition');
    const existing = assistant.extra?.[RESULT_DATA_KEY];
    if (
      isRecord(existing)
      && existing.runId === commit.runId
      && existing.taskName === commit.task.name
      && existing.status === commit.task.status
      && existing.swipeId === this.runtime.getMessageSwipeId(assistantMessageId)
      && existing.panelHash === fingerprintText(panel)
      && /<task_result>[\s\S]*?<\/task_result>/u.test(assistant.message)
    ) return;
    const nextMessage = insertTerminalPanelText(assistant.message, panel);
    await this.runtime.setChatMessages([{
      message_id: assistantMessageId,
      message: nextMessage,
      extra: {
        ...(assistant.extra ?? {}),
        [RESULT_DATA_KEY]: {
          runId: commit.runId,
          taskName: commit.task.name,
          status: commit.task.status,
          triggerMessageId: commit.triggerMessageId,
          swipeId: this.runtime.getMessageSwipeId(assistantMessageId),
          panelHash: fingerprintText(panel),
        },
      },
    }], { refresh: 'affected' });
  }
}

const TASK_RESULT_RE = /<task_result>[\s\S]*?<\/task_result>/gu;

function insertTerminalPanelText(message: string, panel: string): string {
  const stripped = message
    .replace(TASK_RESULT_RE, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd();
  const anchors = ['<butterfly_panel>', '<UpdateVariable>']
    .map(anchor => stripped.indexOf(anchor))
    .filter(index => index >= 0);
  const index = anchors.length > 0 ? Math.min(...anchors) : -1;
  if (index < 0) return `${stripped}\n\n${panel.trim()}`;
  const head = stripped.slice(0, index).trimEnd();
  const tail = stripped.slice(index);
  return `${head}\n\n${panel.trim()}\n${tail}`;
}

function serializeLock(lock: RuinTaskFloorLock): Record<string, unknown> {
  return {
    kind: 'eyon.ruin-task.approved.v1',
    requestId: lock.requestId,
    runId: lock.runId,
    direction: lock.direction,
    task: lock.task,
    contractText: lock.contractText,
    approvedTaskHash: lock.approvedTaskHash,
    namespace: lock.namespace,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function injectionKey(requestId: string): string {
  return `eyon-history-ruin-task-${requestId}`;
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) throw new Error('No active character chat is available');
  return { characterKey, chatId };
}

function requireMessage(runtime: TavernRuntime, messageId: number) {
  const message = runtime.getChatMessages(messageId, { include_swipes: false })
    .find(item => item.message_id === messageId);
  if (!message) throw new Error(`Message ${messageId} is unavailable`);
  return message;
}
