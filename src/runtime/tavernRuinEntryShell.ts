import { namespaceKey } from '../core/namespace.ts';
import type { TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

const REQUEST_DATA_KEY = 'eyonHistoryRuinEntryRequest';
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;

/**
 * 进入特异点的楼层锁:武装注入与提交校验之间的全部身份快照。
 * 与传记的 BiographyFloorLock 同构;首版不做 reuse/重roll 复用,
 * 要求新助手楼紧邻触发玩家楼(triggerId + 1)。
 */
export interface RuinEntryFloorLock {
  requestId: string;
  recordKey: string;
  candidateId: string;
  nodeId: string;
  /** 玩家楼 messageId(sendUserTurn 返回) */
  triggerMessageId: number;
  /** 玩家楼实际文本(决议后的玩家原话或默认语) */
  playerText: string;
  /** 注入层契约全文(【历史工作台·单楼进入契约】+ RuinTrace) */
  contractText: string;
  /** 权威 RuinTrace 文本(serializeRuinTrace 输出,提交时组装进穿越助手楼) */
  traceText: string;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  namespace: { characterKey: string; chatId: string };
}

/**
 * 进入特异点的注入壳:武装/清理常驻注入 + 渲染楼层断言 + 元数据写回。
 * 通道与传记/蝴蝶效应一致:ST 原生 setExtensionPrompt(in_chat / depth 0 / system),
 * 由本模块在提交成功或失败路径显式 clear,不留常驻残留。
 */
export class TavernRuinEntryShellAdapter {
  private readonly runtime: TavernRuntime;

  constructor(runtime: TavernRuntime) {
    this.runtime = runtime;
  }

  async arm(lock: RuinEntryFloorLock): Promise<void> {
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
    lock: RuinEntryFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const namespace = currentNamespace(this.runtime);
    if (
      namespaceKey(namespace) !== namespaceKey(lock.namespace)
    ) {
      throw new Error('Chat changed before ruin entry narrative was rendered');
    }

    const trigger = requireMessage(this.runtime, lock.triggerMessageId);
    if (
      trigger.role !== 'user'
      || trigger.is_hidden
      || fingerprintText(trigger.message) !== lock.triggerTextHash
      || this.runtime.getMessageSwipeId(lock.triggerMessageId) !== lock.triggerSwipeId
    ) {
      console.warn('[Eyon History Workbench] ruin entry trigger floor rejected', {
        triggerId: lock.triggerMessageId,
        triggerRole: trigger.role,
        triggerHidden: trigger.is_hidden,
        swipe: this.runtime.getMessageSwipeId(lock.triggerMessageId),
        expectedSwipe: lock.triggerSwipeId,
      });
      throw new Error('Ruin entry trigger floor changed before commit');
    }

    const assistant = requireMessage(this.runtime, assistantMessageId);
    const assistantOk = assistant.role === 'assistant'
      && !assistant.is_hidden
      && this.runtime.getLastMessageId() === assistantMessageId;
    if (!assistantOk) {
      console.warn('[Eyon History Workbench] ruin entry rendered floor rejected', {
        assistantMessageId,
        assistantRole: assistant.role,
        assistantHidden: assistant.is_hidden,
        lastMessageId: this.runtime.getLastMessageId(),
        adjacent: assistantMessageId === lock.triggerMessageId + 1,
      });
      throw new Error('Rendered assistant floor does not belong to the ruin entry request');
    }
    // 首版严格紧邻:进入是单发事件,新助手楼必须紧邻触发玩家楼。
    // 若实测发现 regenerate/swipe 需要,再按传记 reuse 语义升级。
    if (assistantMessageId !== lock.triggerMessageId + 1) {
      throw new Error('Rendered assistant floor does not belong to the ruin entry request');
    }
  }

  async attachRequestMetadata(
    lock: RuinEntryFloorLock,
    assistantMessageId: number,
  ): Promise<void> {
    const assistant = requireMessage(this.runtime, assistantMessageId);
    const metadata = {
      requestId: lock.requestId,
      triggerMessageId: lock.triggerMessageId,
      triggerTextHash: lock.triggerTextHash,
      playerText: lock.playerText,
      swipeId: this.runtime.getMessageSwipeId(assistantMessageId),
      ruinHistory: ruinHistoryFromContract(lock.contractText),
    };
    // 宿主（JS-Slash-Runner）的 setChatMessages 里，extra 的写回只在
    // 「含 message 或 data 字段」的 is_chat_message 分支触发，并在该分支里
    // 自动双写：data.extra 与 data.swipe_info[swipe_id].extra（随 swipe/删楼/
    // 分支正确回滚）。因此这里必须带上当前正文 message（值不变、仅作分支触发器），
    // 否则只传 extra+swipeInfo 时宿主不认识 swipeInfo 字段、整个写入是 no-op。
    // 该坑位与传记壳一致（tavernBiographyShell.attachRequestMetadata）。
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
}

function injectionKey(requestId: string): string {
  return `eyon-history-ruin-entry-${requestId}`;
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

function ruinHistoryFromContract(text: string) {
  const field = (label: string) => {
    const match = text.match(new RegExp(`${label}：([^\\n]+)`, 'u'));
    return match?.[1]?.trim() ?? '';
  };
  return {
    title: field('史案标题'),
    era: field('目标纪元'),
    stage: field('历史阶段'),
    nodeTime: field('目标墟境时间'),
    nodeLocation: field('目标墟境地点'),
    nodeTitle: field('历史节点'),
    originalTrajectory: field('节点局势'),
    historicalBackground: field('直接成因'),
    // 字段名为旧持久化合同，值现在允许来自四阶段；旧注入仍读「特异点」。
    enteredAnomaly: field('历史节点') || field('特异点'),
    locationChain: [field('目标墟境地点')].filter(Boolean),
    visibleTrace: field('可感知痕迹'),
    intervention: field('玩家可介入条件'),
    possibleBranches: field('可能分支'),
    participants: field('参与人物与组织'),
    selectedDirection: field('玩家补充方向'),
  };
}
