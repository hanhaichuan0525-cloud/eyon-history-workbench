import type { TavernRuntime } from './contracts.ts';

/**
 * 判断两楼是否构成当前最新的一组“可见玩家楼 → 可见 AI 楼”。
 *
 * 酒馆或 MVU 可能在二者之间插入隐藏/系统楼；这些宿主实现细节不应
 * 切断业务上的相邻回合，但任何额外的可见玩家楼或 AI 楼仍会使绑定失效。
 */
export function isLatestVisibleTurnPair(
  runtime: TavernRuntime,
  userMessageId: number,
  assistantMessageId: number,
): boolean {
  if (
    !Number.isInteger(userMessageId)
    || !Number.isInteger(assistantMessageId)
    || assistantMessageId <= userMessageId
  ) return false;

  const lastMessageId = Math.max(runtime.getLastMessageId(), assistantMessageId);
  const visibleTurns = runtime
    .getChatMessages(`0-${lastMessageId}`, { include_swipes: false })
    .filter(message =>
      !message.is_hidden
      && (message.role === 'user' || message.role === 'assistant')
    )
    .sort((left, right) => left.message_id - right.message_id);
  const assistantIndex = visibleTurns.findIndex(message =>
    message.message_id === assistantMessageId
  );
  if (assistantIndex <= 0) return false;

  const user = visibleTurns[assistantIndex - 1];
  const assistant = visibleTurns[assistantIndex];
  return user.message_id === userMessageId
    && user.role === 'user'
    && assistant.role === 'assistant'
    && visibleTurns.at(-1)?.message_id === assistantMessageId;
}
