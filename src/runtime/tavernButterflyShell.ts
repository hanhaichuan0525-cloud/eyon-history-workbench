import { namespaceKey } from '../core/namespace.ts';
import { normalizeCommandInput } from '../core/commands.ts';
import { buildButterflyNarrativeInstruction } from '../prompts/butterfly.ts';
import type { ButterflyResult } from '../schemas/butterfly.ts';
import type { PendingSettlement } from '../storage/butterflies.ts';
import type { TavernRuntime } from './contracts.ts';
import { isLatestVisibleTurnPair } from './visibleTurns.ts';

const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

export interface ButterflyNarrativeShell {
  arm(pending: PendingSettlement, result?: ButterflyResult): Promise<void>;
  clear(requestId: string): Promise<void>;
  clearActive(): Promise<void>;
  assertRenderedFloor(
    pending: PendingSettlement,
    assistantMessageId: number,
  ): Promise<void>;
}

export class TavernButterflyNarrativeShell
implements ButterflyNarrativeShell {
  private readonly runtime: TavernRuntime;
  private readonly activeRequestIds = new Set<string>();

  constructor(runtime: TavernRuntime) {
    this.runtime = runtime;
  }

  async arm(
    pending: PendingSettlement,
    result?: ButterflyResult,
  ): Promise<void> {
    for (const requestId of [...this.activeRequestIds]) {
      if (requestId !== pending.request.requestId) await this.clear(requestId);
    }
    await this.runtime.setExtensionPrompt(
      injectionKey(pending.request.requestId),
      buildButterflyNarrativeInstruction(result),
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
    this.activeRequestIds.add(pending.request.requestId);
  }

  async clear(requestId: string): Promise<void> {
    await this.runtime.setExtensionPrompt(
      injectionKey(requestId),
      '',
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
    this.activeRequestIds.delete(requestId);
  }

  async clearActive(): Promise<void> {
    await Promise.all([...this.activeRequestIds].map(requestId =>
      this.clear(requestId)
    ));
  }

  async assertRenderedFloor(
    pending: PendingSettlement,
    assistantMessageId: number,
  ): Promise<void> {
    if (namespaceKey(currentNamespace(this.runtime)) !== namespaceKey(pending.namespace)) {
      throw new Error('遣返正文生成前角色卡或聊天已经变化');
    }
    const userMessageId = pending.request.trigger.userMessageId;
    const user = requireMessage(this.runtime, userMessageId);
    const assistant = requireMessage(this.runtime, assistantMessageId);
    if (
      user.role !== 'user'
      || user.is_hidden
      || normalizeCommandInput(user.message)
        !== normalizeCommandInput(pending.request.trigger.rawCommand)
      || (
        pending.triggerSwipeId !== undefined
        && this.runtime.getMessageSwipeId(userMessageId) !== pending.triggerSwipeId
      )
      || assistant.role !== 'assistant'
      || assistant.is_hidden
      || !isLatestVisibleTurnPair(
        this.runtime,
        userMessageId,
        assistantMessageId,
      )
    ) {
      throw new Error('渲染的 AI 楼不属于本次遣返请求');
    }
  }
}

export const noopButterflyNarrativeShell: ButterflyNarrativeShell = {
  async arm() {},
  async clear() {},
  async clearActive() {},
  async assertRenderedFloor() {},
};

function injectionKey(requestId: string): string {
  return `eyon-history-butterfly-${requestId}`;
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) throw new Error('当前没有可用的角色聊天');
  return { characterKey, chatId };
}

function requireMessage(runtime: TavernRuntime, messageId: number) {
  const message = runtime
    .getChatMessages(messageId, { include_swipes: false })
    .find(item => item.message_id === messageId);
  if (!message) throw new Error(`消息楼 ${messageId} 已经不可用`);
  return message;
}
