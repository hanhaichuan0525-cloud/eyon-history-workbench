import type {
  BiographyPreparation,
  BiographyShellAdapter,
} from '../workflows/biography.ts';
import { namespaceKey } from '../core/namespace.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';
import { isLatestVisibleTurnPair } from './visibleTurns.ts';

const REQUEST_DATA_KEY = 'eyonHistoryRequest';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

export interface BiographyFloorLock {
  preparation: BiographyPreparation;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  /** 重 roll 复用模式：酒馆可能重建消息 ID，新助手楼不再紧邻触发楼 */
  reuse?: boolean;
}

export class TavernBiographyShellAdapter implements BiographyShellAdapter {
  private readonly runtime: TavernRuntime;

  constructor(runtime: TavernRuntime) {
    this.runtime = runtime;
  }

  async arm(lock: BiographyFloorLock): Promise<void> {
    // 使用 ST 原生常驻注入通道（与蝴蝶效应一致），commit 时 clear 收尾。
    // 不用 injectPrompts({once:true})：该通道在宿主 UI 发起的正文生成中
    // 是否生效不可靠，协作指令一旦未进入正文模型上下文，模型就会自由
    // 发挥生成无美化的假传记。
    await this.runtime.setExtensionPrompt(
      injectionKey(lock.preparation.requestId),
      lock.preparation.instruction,
      IN_CHAT,
      INJECTION_DEPTH,
      false,
      ROLE_SYSTEM,
      null,
    );
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
  }

  async assertRenderedFloor(
    lock: BiographyFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const namespace = currentNamespace(this.runtime);
    if (namespaceKey(namespace) !== namespaceKey(lock.preparation.scope.namespace)) {
      throw new Error('Chat changed before biography narrative was rendered');
    }

    const triggerId = lock.preparation.scope.triggerMessageId;
    const trigger = requireMessage(this.runtime, triggerId);
    if (
      trigger.role !== 'user'
      || trigger.is_hidden
      || fingerprintText(trigger.message) !== lock.triggerTextHash
      || this.runtime.getMessageSwipeId(triggerId) !== lock.triggerSwipeId
    ) {
      console.warn('[Eyon History Workbench] biography trigger floor rejected', {
        triggerId,
        triggerRole: trigger.role,
        triggerHidden: trigger.is_hidden,
        swipe: this.runtime.getMessageSwipeId(triggerId),
        expectedSwipe: lock.triggerSwipeId,
        reuse: lock.reuse ?? false,
      });
      throw new Error('Biography trigger floor changed before commit');
    }

    const assistant = requireMessage(this.runtime, assistantMessageId);
    const assistantOk = assistant.role === 'assistant'
      && !assistant.is_hidden
      && isLatestVisibleTurnPair(this.runtime, triggerId, assistantMessageId);
    if (!assistantOk) {
      console.warn('[Eyon History Workbench] biography rendered floor rejected', {
        assistantMessageId,
        assistantRole: assistant.role,
        assistantHidden: assistant.is_hidden,
        lastMessageId: this.runtime.getLastMessageId(),
        adjacent: assistantMessageId === triggerId + 1,
        reuse: lock.reuse ?? false,
      });
      throw new Error('Rendered assistant floor does not belong to the biography request');
    }
    // 首次生成按“最新可见玩家楼 -> 最新可见 AI 楼”绑定，
    // 宿主中间插入的隐藏 MVU/系统楼不应让租约永久残留。
    // 重 roll 与双入口也使用同一可见回合断言；隐藏系统楼可以夹在中间，
    // 但另一个可见玩家楼或 AI 楼不能被误认成本次传记正文。
  }

  async attachRequestMetadata(
    lock: BiographyFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const assistant = requireMessage(this.runtime, assistantMessageId);
    const metadata = {
      requestId: lock.preparation.requestId,
      triggerMessageId: lock.preparation.scope.triggerMessageId,
      triggerTextHash: lock.triggerTextHash,
      sourceHash: lock.preparation.sourceHash,
      swipeId: this.runtime.getMessageSwipeId(assistantMessageId),
    };
    // 宿主（JS-Slash-Runner）的 setChatMessages 里，extra 的写回只在
    // 「含 message 或 data 字段」的 is_chat_message 分支触发，并在该分支里
    // 自动双写：data.extra 与 data.swipe_info[swipe_id].extra（随 swipe/删楼/
    // 分支正确回滚）。因此这里必须带上当前正文 message（值不变、仅作分支触发器），
    // 否则只传 extra+swipeInfo 时宿主不认识 swipeInfo 字段、整个写入是 no-op。
    // 这正是历史「元数据双写从未真正在宿主生效」的根因。
    await this.runtime.setChatMessages(
      [{
        message_id: assistantMessageId,
        message: assistant.message,
        extra: {
          ...(assistant.extra ?? {}),
          [REQUEST_DATA_KEY]: metadata,
        },
      }],
      { refresh: 'none' },
    );
  }

  async readAssistantMessage(messageId: number): Promise<string> {
    const message = requireMessage(this.runtime, messageId);
    if (message.role !== 'assistant' || message.is_hidden) {
      throw new Error(`Assistant message ${messageId} is unavailable`);
    }
    return message.message;
  }

  async writeAssistantMessage(messageId: number, content: string): Promise<void> {
    await this.readAssistantMessage(messageId);
    await this.runtime.setChatMessages(
      [{ message_id: messageId, message: content }],
      { refresh: 'none' },
    );
  }

  async refreshAssistantMessage(messageId: number): Promise<void> {
    await this.readAssistantMessage(messageId);
    await this.runtime.setChatMessages(
      [{ message_id: messageId }],
      { refresh: 'affected' },
    );
  }
}

function injectionKey(requestId: string): string {
  return `eyon-history-biography-${requestId}`;
}

function currentNamespace(runtime: TavernRuntime) {
  const characterKey = runtime.getCurrentCharacterName()?.trim();
  const chatId = runtime.getCurrentChatId().trim();
  if (!characterKey || !chatId) {
    throw new Error('No active character chat is available');
  }
  return { characterKey, chatId };
}

function requireMessage(runtime: TavernRuntime, messageId: number) {
  const message = runtime
    .getChatMessages(messageId, { include_swipes: false })
    .find(item => item.message_id === messageId);
  if (!message) {
    throw new Error(`Message ${messageId} is unavailable`);
  }
  return message;
}
