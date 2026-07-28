import type { WorkbenchNamespace } from '../core/namespace.ts';
import type {
  ButterflyFreezeSnapshot,
  ButterflyHostAdapter,
} from '../adapters/host.ts';
import {
  ButterflyRequestSchema,
  type ButterflyRequest,
  type ButterflyScope,
} from '../schemas/butterfly.ts';
import type {
  RuntimeContextSourceProvider,
  TavernRuntime,
} from './contracts.ts';
import { fingerprintText } from './transactionIdentity.ts';

const RECENT_LIMIT = 36;
const CONTENT_LIMIT = 6000;

export class TavernButterflyContextAssembler {
  private readonly runtime: TavernRuntime;
  private readonly sources: RuntimeContextSourceProvider;
  private readonly host: ButterflyHostAdapter;

  constructor(
    runtime: TavernRuntime,
    sources: RuntimeContextSourceProvider,
    host: ButterflyHostAdapter,
  ) {
    this.runtime = runtime;
    this.sources = sources;
    this.host = host;
  }

  async freeze(input: {
    requestId: string;
    namespace: WorkbenchNamespace;
    userMessageId: number;
    rawCommand: string;
    triggerType: 'button' | 'text';
    roll: number;
  }): Promise<{ request: ButterflyRequest; sourceHash: string }> {
    const snapshot = await this.host.getButterflyFreezeSnapshot();
    const messages = this.runMessages(input.userMessageId);
    const chatSources = messages.map(message => ({
      sourceId: `chat:${message.message_id}`,
      title: `${message.role} floor ${message.message_id}`,
      content: message.message.trim().slice(0, CONTENT_LIMIT),
    }));
    const interventions = chatSources.filter(source =>
      !/^(?:请)?(?:进入节点|遣返|返回现世|回到现实|结算蝴蝶效应)/u.test(source.content)
    );
    const playerInterventions = (
      interventions.filter(source => source.title.startsWith('user '))
        .concat(interventions.filter(source => source.title.startsWith('assistant ')))
        .slice(-12)
    );
    if (playerInterventions.length === 0) {
      throw new Error('本轮没有可追溯的玩家干涉正文，已拒绝建立空结算');
    }
    const [
      worldbooks,
      characters,
      genealogies,
      biographies,
      butterflies,
    ] = await Promise.all([
      this.sources.getWorldbookSources(),
      this.sources.getCharacterSources(),
      this.sources.getGenealogySources(),
      this.sources.getBiographySources(),
      this.sources.getButterflySources(),
    ]);
    const relevantWorldbook = trimSources(worldbooks, 18);
    const involvedEntities = trimSources(characters, 12);
    const relevantGenealogy = trimSources(genealogies, 8);
    const relevantBiographies = trimSources(biographies, 8);
    const previousButterflyAnchors = trimSources(butterflies, 8);
    const relevantChatFacts = trimSources(chatSources, 24);
    const currentRealityContext = [{
      sourceId: `frozen-reality:${snapshot.runId}`,
      title: 'frozen reality anchor',
      content: `${snapshot.reality.time}\n${snapshot.reality.location}`,
    }];
    const sourceIndex = dedupeSources([
      ...playerInterventions,
      ...involvedEntities,
      ...currentRealityContext,
      ...relevantWorldbook,
      ...relevantChatFacts,
      ...relevantGenealogy,
      ...relevantBiographies,
      ...previousButterflyAnchors,
    ]);
    const entrySource = messages.find(message =>
      /^(?:请)?进入节点(?:[\s，,：:]|$)/u.test(message.message.trim())
    );
    const request = ButterflyRequestSchema.parse({
      schema: 'eyon.butterfly.request.v1',
      requestId: input.requestId,
      characterKey: input.namespace.characterKey,
      chatId: input.namespace.chatId,
      runId: snapshot.runId,
      trigger: {
        type: input.triggerType,
        userMessageId: input.userMessageId,
        returnAssistantMessageId: 0,
        rawCommand: input.rawCommand,
      },
      anchors: {
        reality: snapshot.reality,
        ruinEntry: snapshot.ruinEntry,
        ruinExit: snapshot.ruinExit,
      },
      dice: {
        roll: input.roll,
        scope: scopeForRoll(input.roll),
      },
      ruinHistory: historyFromEntry(entrySource?.message ?? '', snapshot),
      playerInterventions,
      involvedEntities,
      currentRealityContext,
      relevantWorldbook,
      relevantChatFacts,
      relevantGenealogy,
      relevantBiographies,
      previousButterflyAnchors,
      sourceIndex,
    });
    return {
      request,
      sourceHash: fingerprintText(JSON.stringify(request)),
    };
  }

  attachReturnFloor(request: ButterflyRequest, assistantMessageId: number): ButterflyRequest {
    const assistant = this.runtime
      .getChatMessages(assistantMessageId, { include_swipes: false })
      .find(message => message.message_id === assistantMessageId);
    if (!assistant || assistant.role !== 'assistant' || assistant.is_hidden) {
      throw new Error('遣返正文楼不存在或已隐藏');
    }
    const source = {
      sourceId: `chat:${assistant.message_id}`,
      title: `assistant floor ${assistant.message_id}`,
      content: assistant.message.trim().slice(0, CONTENT_LIMIT),
    };
    return ButterflyRequestSchema.parse({
      ...request,
      trigger: {
        ...request.trigger,
        returnAssistantMessageId: assistantMessageId,
      },
      currentRealityContext: dedupeSources([
        ...request.currentRealityContext,
        source,
      ]),
      relevantChatFacts: dedupeSources([
        ...request.relevantChatFacts,
        source,
      ]),
      sourceIndex: dedupeSources([...request.sourceIndex, source]),
    });
  }

  private runMessages(userMessageId: number) {
    const start = Math.max(0, userMessageId - RECENT_LIMIT + 1);
    const messages = this.runtime
      .getChatMessages(`${start}-${userMessageId}`, { include_swipes: false })
      .filter(message => !message.is_hidden && message.message.trim());
    let entryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (/^(?:请)?进入节点(?:[\s，,：:]|$)/u.test(messages[index].message.trim())) {
        entryIndex = index;
        break;
      }
    }
    return entryIndex >= 0 ? messages.slice(entryIndex) : messages;
  }
}

function scopeForRoll(roll: number): ButterflyScope {
  if (roll <= 20) return '个人';
  if (roll <= 35) return '双人';
  if (roll <= 50) return '小队';
  if (roll <= 65) return '聚落';
  if (roll <= 78) return '城市';
  if (roll <= 88) return '省份级地区';
  if (roll <= 96) return '国家';
  return '跨国';
}

function trimSources(
  sources: Array<{ sourceId: string; title: string; content: string }>,
  limit: number,
) {
  return sources
    .filter(source => source.sourceId.trim() && source.content.trim())
    .slice(-limit)
    .map(source => ({
      sourceId: source.sourceId.trim(),
      title: source.title.trim() || source.sourceId.trim(),
      content: source.content.trim().slice(0, CONTENT_LIMIT),
    }));
}

function dedupeSources<T extends { sourceId: string }>(sources: T[]): T[] {
  const seen = new Set<string>();
  return sources.filter(source => {
    if (seen.has(source.sourceId)) return false;
    seen.add(source.sourceId);
    return true;
  });
}

function historyFromEntry(
  text: string,
  snapshot: ButterflyFreezeSnapshot,
) {
  const field = (label: string) => {
    const match = text.match(new RegExp(`${label}：([^\\n]+)`, 'u'));
    return match?.[1]?.trim() ?? '';
  };
  return {
    title: field('史案标题'),
    era: field('目标纪元'),
    originalTrajectory: field('节点局势'),
    historicalBackground: field('直接成因'),
    enteredAnomaly: field('特异点'),
    locationChain: [
      field('目标墟境地点'),
      snapshot.ruinEntry.location,
      snapshot.ruinExit.location,
    ].filter(Boolean),
  };
}
