import type { RuntimeChatMessage, TavernRuntime } from './contracts.ts';

const REPLAY_GENERATION_TYPES = new Set(['regenerate', 'swipe']);

/**
 * Resolve the user floor that actually triggered this generation.
 *
 * Ordinary/unknown generations may only use the latest visible user floor.
 * Looking farther back when the latest visible floor is already an assistant
 * would replay an old workbench command during Continue or other assistant-only
 * turns. Explicit regenerate/swipe may reuse the immediately preceding user
 * floor, but never skip across another assistant floor.
 */
export function findGenerationTriggerUserMessage(
  runtime: TavernRuntime,
  type?: string,
): RuntimeChatMessage | null {
  const lastMessageId = runtime.getLastMessageId();
  if (lastMessageId < 0) return null;
  const visibleConversation = runtime.getChatMessages(
    `0-${lastMessageId}`,
    { include_swipes: false },
  )
    .filter(message =>
      !message.is_hidden
      && (message.role === 'user' || message.role === 'assistant')
    )
    .sort((left, right) => left.message_id - right.message_id);
  const latest = visibleConversation.at(-1);
  if (!latest) return null;
  if (latest.role === 'user') return latest;
  if (!type || !REPLAY_GENERATION_TYPES.has(type)) return null;
  const previous = visibleConversation.at(-2);
  return previous?.role === 'user' ? previous : null;
}
