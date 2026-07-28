import type { GenerationAdapter } from '../adapters/host.ts';
import type { GenealogyContextAssembler } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  buildGenealogyApiPrompt,
  type GenealogyRuleSet,
} from '../prompts/genealogy.ts';
import {
  GenealogyGenerationInputSchema,
  type GenealogyGenerationInput,
} from '../schemas/genealogy.ts';
import {
  genealogyRecordKey,
  type GenealogyRecord,
  type GenealogyRepository,
} from '../storage/genealogies.ts';
import { parseAndValidateGenealogy } from '../validators/genealogy.ts';

export interface GenealogyRequestIdentity {
  namespace: WorkbenchNamespace;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  lifecycleEpoch: number;
}

export interface GenealogyWorkflowDependencies {
  contextAssembler: GenealogyContextAssembler;
  generator: GenerationAdapter;
  repository: GenealogyRepository;
  rules: GenealogyRuleSet;
  createRequestId(): string;
  now(): number;
  assertCurrent(identity: GenealogyRequestIdentity): Promise<void>;
}

export class GenealogyWorkflow {
  private readonly dependencies: GenealogyWorkflowDependencies;

  constructor(dependencies: GenealogyWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  async generate(
    command: WorkbenchCommand,
    rawInput: GenealogyGenerationInput,
    identity: GenealogyRequestIdentity,
  ): Promise<GenealogyRecord> {
    if (command.type !== 'genealogy.generate') {
      throw new Error('Genealogy workflow received a different command type');
    }
    const input = GenealogyGenerationInputSchema.parse(rawInput);
    const requestId = this.dependencies.createRequestId();
    const context = await this.dependencies.contextAssembler.assemble({
      requestId,
      namespace: identity.namespace,
      triggerMessageId: identity.triggerMessageId,
      directive: command.raw || `宗族谱系 ${input.focusCharacter.name}`,
    });
    if (
      namespaceKey(context.scope) !== namespaceKey(identity.namespace)
      || context.scope.triggerMessageId !== identity.triggerMessageId
    ) {
      throw new Error('Genealogy context belongs to a different chat request');
    }
    const focusSource = context.characterContext.find(source =>
      source.sourceId === `mvu-character:${input.focusCharacter.mvuId}`
      || normalize(source.title) === normalize(input.focusCharacter.name)
    );
    if (!focusSource) {
      throw new Error('只有当前聊天MVU关系列表中的人物可以建立族谱');
    }

    const prompt = buildGenealogyApiPrompt({
      requestId,
      directive: command.raw || `宗族谱系 ${input.focusCharacter.name}`,
      generationInput: input,
      context,
      rules: this.dependencies.rules,
    });
    const rawResult = await this.dependencies.generator.generate('genealogy', prompt);
    const result = parseAndValidateGenealogy(rawResult, {
      requestId,
      input,
      context,
    });

    await this.dependencies.assertCurrent(identity);
    const record: GenealogyRecord = {
      key: genealogyRecordKey(identity.namespace, requestId),
      namespace: identity.namespace,
      requestId,
      triggerMessageId: identity.triggerMessageId,
      triggerTextHash: identity.triggerTextHash,
      triggerSwipeId: identity.triggerSwipeId,
      sourceHash: context.sourceHash,
      input,
      result,
      createdAt: this.dependencies.now(),
    };
    await this.dependencies.repository.save(record);
    return record;
  }
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}
