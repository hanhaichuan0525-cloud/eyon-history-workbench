import type {
  ContextSource,
  GenealogyContextAssembler,
  GenealogyContextBundle,
} from '../core/context.ts';
import type { RuntimeContextSourceProvider, TavernRuntime } from './contracts.ts';

const RECENT_MESSAGE_LIMIT = 24;
const CONTENT_LIMIT = 12000;

export class TavernGenealogyContextAssembler implements GenealogyContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;

  constructor(runtime: TavernRuntime, sources: RuntimeContextSourceProvider) {
    this.runtime = runtime;
    this.sources = sources;
  }

  async assemble(input: {
    requestId: string;
    namespace: { characterKey: string; chatId: string };
    triggerMessageId: number;
    directive: string;
  }): Promise<GenealogyContextBundle> {
    const [currentWorld, worldbook, characters, biographies] = await Promise.all([
      this.sources.getCurrentWorld(),
      this.sources.getWorldbookSources(),
      this.sources.getCharacterSources(),
      this.sources.getBiographySources(),
    ]);
    const worldbookContext = mapSources(worldbook, 'worldbook', 100);
    const recentContext = mapSources(
      this.buildRecentSources(input.triggerMessageId),
      'chat',
      80,
    );
    const characterContext = mapSources(characters, 'mvu', 95);
    const biographyRefs = mapSources(biographies, 'biography', 70);
    const sourceIndex = [
      ...worldbookContext,
      ...characterContext,
      ...recentContext,
      ...biographyRefs,
    ];
    const warnings: string[] = [];
    if (worldbookContext.length === 0) warnings.push('worldbook_context_empty');
    if (characterContext.length === 0) warnings.push('character_context_empty');

    return {
      schema: 'eyon.context.v1',
      taskType: 'genealogy',
      requestId: input.requestId,
      scope: { ...input.namespace, triggerMessageId: input.triggerMessageId },
      currentWorld,
      worldbookContext,
      recentContext,
      characterContext,
      biographyRefs,
      sourceIndex,
      warnings,
      sourceHash: await hashSources(input.directive, currentWorld, sourceIndex),
    };
  }

  private buildRecentSources(triggerMessageId: number) {
    const start = Math.max(0, triggerMessageId - RECENT_MESSAGE_LIMIT + 1);
    return this.runtime
      .getChatMessages(`${start}-${triggerMessageId}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim())
      .map(message => ({
        sourceId: `chat:${message.message_id}`,
        title: `${message.role} floor ${message.message_id}`,
        content: message.message.slice(0, CONTENT_LIMIT),
      }));
  }
}

function mapSources(
  sources: Array<{ sourceId: string; title: string; content: string }>,
  sourceType: ContextSource['sourceType'],
  authority: number,
): ContextSource[] {
  const seen = new Set<string>();
  return sources.flatMap(source => {
    const sourceId = source.sourceId.trim();
    const content = source.content.trim().slice(0, CONTENT_LIMIT);
    if (!sourceId || !content || seen.has(sourceId)) return [];
    seen.add(sourceId);
    return [{
      sourceId,
      sourceType,
      title: source.title.trim() || sourceId,
      content,
      authority,
    }];
  });
}

async function hashSources(
  directive: string,
  currentWorld: { time: string; location: string },
  sources: ContextSource[],
): Promise<string> {
  const input = JSON.stringify({
    directive,
    currentWorld,
    sources: sources.map(source => [
      source.sourceId,
      source.sourceType,
      source.content,
    ]),
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}
