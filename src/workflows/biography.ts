import type { BiographyContextAssembler } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import { createSlot } from '../core/slots.ts';
import type { GenerationAdapter } from '../adapters/host.ts';
import {
  buildBiographyApiPrompt,
  buildBiographyShellInstruction,
  type BiographyRuleSet,
} from '../prompts/biography.ts';
import {
  biographyRecordKey,
  type BiographyRecord,
  type BiographyRepository,
} from '../storage/biographies.ts';
import { parseAndValidateBiography } from '../validators/biography.ts';
import { insertRootTrace } from './messageAssembly.ts';

export interface BiographyShellAdapter {
  generateShell(input: {
    requestId: string;
    instruction: string;
    slot: string;
  }): Promise<{ messageId: number }>;
  readAssistantMessage(messageId: number): Promise<string>;
  writeAssistantMessage(messageId: number, content: string): Promise<void>;
  refreshAssistantMessage(messageId: number): Promise<void>;
}

export interface BiographyWorkflowScope {
  namespace: {
    characterKey: string;
    chatId: string;
  };
  triggerMessageId: number;
}

export interface BiographyWorkflowDependencies {
  contextAssembler: BiographyContextAssembler;
  generator: GenerationAdapter;
  shell: BiographyShellAdapter;
  repository: BiographyRepository;
  rules: BiographyRuleSet;
  getScope(): Promise<BiographyWorkflowScope>;
  createRequestId(): string;
  now(): number;
}

export interface BiographyWorkflowResult {
  requestId: string;
  biographyId: string;
  assistantMessageId: number;
  warning: 'none' | 'slot_missing' | 'court_missing';
}

export class BiographyWorkflow {
  private readonly dependencies: BiographyWorkflowDependencies;

  constructor(dependencies: BiographyWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  async run(command: WorkbenchCommand): Promise<BiographyWorkflowResult> {
    if (command.type !== 'biography.generate') {
      throw new Error('Biography workflow received a different command type');
    }

    const initialScope = await this.dependencies.getScope();
    const requestId = this.dependencies.createRequestId();
    const context = await this.dependencies.contextAssembler.assemble({
      requestId,
      namespace: initialScope.namespace,
      triggerMessageId: initialScope.triggerMessageId,
      directive: command.raw,
    });
    this.assertScope(initialScope, context.scope);

    const prompt = buildBiographyApiPrompt({
      requestId,
      directive: command.raw,
      context,
      rules: this.dependencies.rules,
    });
    const rawResult = await this.dependencies.generator.generate('biography', prompt);
    const biography = parseAndValidateBiography(rawResult, {
      requestId,
      directive: command.raw,
      context,
    });

    await this.assertCurrentScope(initialScope);
    const biographyId = `bio-${requestId}`;
    const key = biographyRecordKey(initialScope.namespace, biographyId);
    const now = this.dependencies.now();
    const record: BiographyRecord = {
      key,
      namespace: initialScope.namespace,
      biographyId,
      requestId,
      triggerMessageId: initialScope.triggerMessageId,
      assistantMessageId: null,
      sourceHash: context.sourceHash,
      status: 'validated',
      revision: 1,
      biography,
      createdAt: now,
      updatedAt: now,
    };
    await this.dependencies.repository.saveValidated(record);

    const slot = createSlot('rootTrace', requestId);
    const shellResult = await this.dependencies.shell.generateShell({
      requestId,
      instruction: buildBiographyShellInstruction(biography, slot),
      slot,
    });

    await this.assertCurrentScope(initialScope);
    const message = await this.dependencies.shell.readAssistantMessage(shellResult.messageId);
    const assembled = insertRootTrace(message, slot, biography.rootTrace);
    await this.dependencies.shell.writeAssistantMessage(shellResult.messageId, assembled.content);
    await this.dependencies.shell.refreshAssistantMessage(shellResult.messageId);
    await this.dependencies.repository.markCommitted(key, shellResult.messageId);

    return {
      requestId,
      biographyId,
      assistantMessageId: shellResult.messageId,
      warning: assembled.warning,
    };
  }

  private assertScope(
    expected: BiographyWorkflowScope,
    actual: BiographyWorkflowScope['namespace'] & { triggerMessageId: number },
  ): void {
    if (
      namespaceKey(expected.namespace) !== namespaceKey(actual)
      || expected.triggerMessageId !== actual.triggerMessageId
    ) {
      throw new Error('Biography context belongs to a different chat request');
    }
  }

  private async assertCurrentScope(expected: BiographyWorkflowScope): Promise<void> {
    const current = await this.dependencies.getScope();
    if (
      namespaceKey(expected.namespace) !== namespaceKey(current.namespace)
      || expected.triggerMessageId !== current.triggerMessageId
    ) {
      throw new Error('Chat changed while biography request was running');
    }
  }
}
