import { normalizeCommandInput } from '../core/commands.ts';
import type { PendingSettlement } from '../storage/butterflies.ts';
import type { RuntimeChatMessage, TavernRuntime } from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

export const BUTTERFLY_SOURCE_IDENTITY_VERSION = 3;
const AUTHORIZATION_KEY = 'eyonWorkbenchReturn';

/** 不含遣返 AI 楼；正文重 roll 不改变来源身份。 */
export function butterflyTriggerEvidenceHash(runtime: TavernRuntime, userMessageId: number, rawCommand: string): string {
  const messages = runtime.getChatMessages(`0-${userMessageId}`, { include_swipes: false })
    .filter(message => message.message_id < userMessageId && !message.is_hidden);
  let start = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (/\[RuinTrace\]|^(?:请)?进入节点/u.test(message.message)
      || !!message.extra?.eyonHistoryRuinEntryRequest
      || !!(message.data?.extra as Record<string, unknown> | undefined)?.eyonHistoryRuinEntryRequest) {
      start = index; break;
    }
  }
  if (start < 0) start = 0;
  return fingerprintText(JSON.stringify({
    sourceIdentityVersion: BUTTERFLY_SOURCE_IDENTITY_VERSION,
    userMessageId, rawCommand: normalizeCommandInput(rawCommand),
    floors: messages.slice(start).map(message => [message.message_id, message.role,
      runtime.getMessageSwipeId(message.message_id), message.message, message.extra?.eyonHistoryRuinEntryRequest]),
  }));
}

/** 只写玩家楼元数据，不写 MVU，也不改玩家正文。准备成功后才签发。 */
export async function markWorkbenchReturn(runtime: TavernRuntime, pending: PendingSettlement): Promise<void> {
  const trigger = pending.request.trigger;
  if (trigger.type !== 'button') return;
  const user = runtime.getChatMessages(trigger.userMessageId, { include_swipes: false })
    .find(message => message.message_id === trigger.userMessageId);
  if (!user || user.role !== 'user' || user.is_hidden
    || normalizeCommandInput(user.message) !== normalizeCommandInput(trigger.rawCommand)
    || runtime.getCurrentCharacterName()?.trim() !== pending.namespace.characterKey
    || runtime.getCurrentChatId()?.trim() !== pending.namespace.chatId) {
    throw new Error('遣返授权不属于当前聊天的玩家楼');
  }
  const evidenceHash = butterflyTriggerEvidenceHash(runtime, user.message_id, user.message);
  if (pending.triggerEvidenceHash && pending.triggerEvidenceHash !== evidenceHash) {
    throw new Error('遣返准备期间行动来源已变化，请回到工作台重新准备');
  }
  if (isWorkbenchReturnAuthorized(runtime, user, pending.runId)) return;
  const extra = { ...record(user.data?.extra), ...user.extra,
    [AUTHORIZATION_KEY]: {
      version: 1, ...pending.namespace, runId: pending.runId,
      userMessageId: user.message_id, requestId: pending.request.requestId,
      rawCommand: normalizeCommandInput(user.message), swipeId: runtime.getMessageSwipeId(user.message_id),
      evidenceHash,
    },
  };
  await runtime.setChatMessages([{
    // 助手普通消息更新需含 message 或 data 才会写 extra；原文原样带回，不重写 MVU data。
    message_id: user.message_id, message: user.message, extra,
  }], { refresh: 'none' });
  const saved = runtime.getChatMessages(user.message_id, { include_swipes: false })
    .find(message => message.message_id === user.message_id);
  // Promise 成功不等于元数据落盘；回读同楼、同swipe、同来源后才能登记并触发正文。
  if (!saved || saved.message !== user.message || !isWorkbenchReturnAuthorized(runtime, saved, pending.runId)) {
    throw new Error('遣返授权写入后校验失败，请保留玩家楼并重试。');
  }
}

/** 仅接受工作台写入的同卡/聊天/轮次/楼层授权，正文文字本身不是授权。 */
export function isWorkbenchReturnAuthorized(runtime: TavernRuntime, user: RuntimeChatMessage, runId: string): boolean {
  const marker = record(user.extra?.[AUTHORIZATION_KEY] ?? record(user.data?.extra)[AUTHORIZATION_KEY]);
  return user.role === 'user' && !user.is_hidden && !!runId
    && marker.version === 1 && marker.runId === runId
    && marker.characterKey === runtime.getCurrentCharacterName()?.trim()
    && marker.chatId === runtime.getCurrentChatId()?.trim()
    && marker.userMessageId === user.message_id && typeof marker.requestId === 'string' && !!marker.requestId
    && marker.rawCommand === normalizeCommandInput(user.message)
    && marker.swipeId === runtime.getMessageSwipeId(user.message_id)
    && marker.evidenceHash === butterflyTriggerEvidenceHash(runtime, user.message_id, user.message);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
