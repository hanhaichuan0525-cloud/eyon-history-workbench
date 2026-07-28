import type {
  ArchiveAdapter,
  ButterflyHostAdapter,
  GenerationAdapter,
} from '../adapters/host.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  buildButterflyApiPrompt,
  type ButterflyRuleSet,
} from '../prompts/butterfly.ts';
import {
  butterflyArchiveKeywords,
  serializeButterflyArchive,
  serializeButterflyPanel,
} from '../renderers/butterfly.ts';
import {
  butterflyRecordKey,
  type ButterflyRecord,
  type ButterflyRepository,
  type PendingSettlement,
} from '../storage/butterflies.ts';
import { parseAndValidateButterfly } from '../validators/butterfly.ts';

export class ButterflyWorkflow {
  private readonly generator: GenerationAdapter;
  private readonly repository: ButterflyRepository;
  private readonly host: ButterflyHostAdapter;
  private readonly archive: ArchiveAdapter;
  private readonly rules: ButterflyRuleSet;
  private readonly now: () => number;

  constructor(dependencies: {
    generator: GenerationAdapter;
    repository: ButterflyRepository;
    host: ButterflyHostAdapter;
    archive: ArchiveAdapter;
    rules: ButterflyRuleSet;
    now(): number;
  }) {
    this.generator = dependencies.generator;
    this.repository = dependencies.repository;
    this.host = dependencies.host;
    this.archive = dependencies.archive;
    this.rules = dependencies.rules;
    this.now = dependencies.now;
  }

  async activateNamespace(namespace: {
    characterKey: string;
    chatId: string;
  }): Promise<void> {
    await this.archive.activateNamespace?.(namespace);
  }

  async settle(pending: PendingSettlement): Promise<ButterflyRecord> {
    let existing = await this.repository.getRecord(
      butterflyRecordKey(pending.namespace, pending.runId),
    );
    if (existing) {
      const currentAssistantId = pending.request.trigger.returnAssistantMessageId;
      const needsRebind = (
        existing.assistantMessageId !== currentAssistantId
        || existing.request.trigger.userMessageId
          !== pending.request.trigger.userMessageId
        || existing.request.trigger.rawCommand
          !== pending.request.trigger.rawCommand
      );
      if (needsRebind) {
        existing = {
          ...existing,
          request: pending.request,
          assistantMessageId: currentAssistantId,
          status: 'validated',
          revision: existing.revision + 1,
          updatedAt: this.now(),
        };
        await this.repository.updateRecord(existing);
      } else if (existing.status === 'committed') {
        await this.repository.deletePending(pending.key);
        return existing;
      }
      return this.resume(existing, pending);
    }

    const prompt = buildButterflyApiPrompt({
      request: pending.request,
      rules: this.rules,
    });
    const raw = await this.generator.generate('butterfly', prompt);
    const result = parseAndValidateButterfly(raw, pending.request);
    await this.assertCurrent(pending);

    const existingRecords = await this.repository.list(pending.namespace);
    const title = `《蝴蝶效应锚定日志${existingRecords.length + 1}》`;
    const panel = serializeButterflyPanel(result.effect);
    const archiveEntry = serializeButterflyArchive({
      title,
      anchors: pending.request.anchors,
      effect: result.effect,
    });
    const now = this.now();
    let record: ButterflyRecord = {
      key: butterflyRecordKey(pending.namespace, pending.runId),
      namespace: pending.namespace,
      runId: pending.runId,
      requestId: pending.request.requestId,
      request: pending.request,
      result,
      sourceHash: pending.sourceHash,
      panel,
      archiveEntry,
      assistantMessageId: pending.request.trigger.returnAssistantMessageId,
      status: 'validated',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.saveRecord(record);
    return this.resume(record, pending);
  }

  private async resume(
    record: ButterflyRecord,
    pending: PendingSettlement,
  ): Promise<ButterflyRecord> {
    await this.assertCurrent(pending);
    if (record.status === 'validated') {
      await this.host.appendButterflyPanel(
        record.assistantMessageId,
        record.requestId,
        record.panel,
      );
      record = {
        ...record,
        status: 'message_committed',
        revision: record.revision + 1,
        updatedAt: this.now(),
      };
      await this.repository.updateRecord(record);
    }
    if (record.status === 'message_committed' || record.status === 'mirror_pending') {
      const keywords = butterflyArchiveKeywords({
        anchors: record.request.anchors,
        historicalKeywords: record.result.effect.historicalKeywords,
      });
      try {
        const mirrored = await this.archive.mirrorButterflyRecord({
          namespace: record.namespace,
          runId: record.runId,
          assistantMessageId: record.assistantMessageId,
          title: archiveTitle(record.archiveEntry),
          content: record.archiveEntry,
          keywords,
          signature: record.sourceHash,
        });
        record = {
          ...record,
          status: 'committed',
          worldbookName: mirrored.worldbookName,
          worldbookUid: mirrored.uid,
          revision: record.revision + 1,
          updatedAt: this.now(),
        };
        await this.repository.updateRecord(record);
        await this.repository.deletePending(pending.key);
      } catch (error) {
        record = {
          ...record,
          status: 'mirror_pending',
          revision: record.revision + 1,
          updatedAt: this.now(),
        };
        await this.repository.updateRecord(record);
        throw error;
      }
    }
    return record;
  }

  private async assertCurrent(pending: PendingSettlement): Promise<void> {
    const request = pending.request;
    const namespace = await this.host.getNamespace();
    if (namespaceKey(namespace) !== namespaceKey({
      characterKey: request.characterKey,
      chatId: request.chatId,
    })) {
      throw new Error('蝴蝶效应返回时角色卡或聊天已经变化');
    }
    await this.host.assertButterflyTarget({
      requestId: request.requestId,
      userMessageId: request.trigger.userMessageId,
      assistantMessageId: request.trigger.returnAssistantMessageId,
      assistantSwipeId: pending.assistantSwipeId,
      rawCommand: request.trigger.rawCommand,
    });
  }
}

function archiveTitle(content: string): string {
  return content.match(/^###\s+(.+)$/mu)?.[1]?.trim()
    || '《蝴蝶效应锚定日志》';
}
