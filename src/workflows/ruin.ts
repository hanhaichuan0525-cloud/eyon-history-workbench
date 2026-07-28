import type { GenerationAdapter } from '../adapters/host.ts';
import type { RuinContextAssembler } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import { buildRuinApiPrompt, type RuinRuleSet } from '../prompts/ruin.ts';
import {
  RuinGenerationInputSchema,
  type RuinCandidates,
  type RuinGenerationInput,
} from '../schemas/ruin.ts';
import {
  ruinCandidateRecordKey,
  type RuinCandidateRecord,
  type RuinCandidateRepository,
} from '../storage/ruins.ts';
import { parseAndValidateRuinCandidates } from '../validators/ruin.ts';

export interface RuinRequestIdentity {
  namespace: WorkbenchNamespace;
  triggerMessageId: number;
  triggerTextHash: string;
  triggerSwipeId: number | null;
  lifecycleEpoch: number;
}

export interface RuinWorkflowDependencies {
  contextAssembler: RuinContextAssembler;
  generator: GenerationAdapter;
  repository: RuinCandidateRepository;
  rules: RuinRuleSet;
  createRequestId(): string;
  now(): number;
  assertCurrent(identity: RuinRequestIdentity): Promise<void>;
}

export class RuinWorkflow {
  private readonly dependencies: RuinWorkflowDependencies;

  constructor(dependencies: RuinWorkflowDependencies) {
    this.dependencies = dependencies;
  }

  async generate(
    command: WorkbenchCommand,
    rawInput: RuinGenerationInput,
    identity: RuinRequestIdentity,
  ): Promise<RuinCandidateRecord> {
    if (command.type !== 'ruin.generate') {
      throw new Error('Ruin workflow received a different command type');
    }
    const input = RuinGenerationInputSchema.parse(rawInput);
    if (
      input.materials.length !== input.wave.candidateCount
      || new Set(input.materials.map(material => material.candidateKey)).size
        !== input.materials.length
    ) {
      throw new Error('Ruin materials must map one-to-one to candidate count');
    }

    const requestId = this.dependencies.createRequestId();
    const context = await this.dependencies.contextAssembler.assemble({
      requestId,
      namespace: identity.namespace,
      triggerMessageId: identity.triggerMessageId,
      directive: command.raw || '墟境探索',
    });
    if (
      namespaceKey(context.scope) !== namespaceKey(identity.namespace)
      || context.scope.triggerMessageId !== identity.triggerMessageId
    ) {
      throw new Error('Ruin context belongs to a different chat request');
    }

    const prompt = buildRuinApiPrompt({
      requestId,
      directive: command.raw || '墟境探索',
      generationInput: input,
      context,
      rules: this.dependencies.rules,
    });
    const rawResult = await this.dependencies.generator.generate('ruin', prompt);
    const result = parseAndValidateRuinCandidates(rawResult, {
      requestId,
      directive: command.raw || '墟境探索',
      input,
      context,
    });

    await this.dependencies.assertCurrent(identity);
    const record: RuinCandidateRecord = {
      key: ruinCandidateRecordKey(identity.namespace, requestId),
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

export function selectEnterableRuinNode(
  record: RuinCandidateRecord,
  candidateId: string,
  nodeId: string,
): {
  candidates: RuinCandidates;
  candidate: RuinCandidates['candidates'][number];
  node: RuinCandidates['candidates'][number]['nodes'][number];
} {
  const candidate = record.result.candidates.find(item => item.id === candidateId);
  if (!candidate) throw new Error('Selected ruin candidate does not exist');
  const node = candidate.nodes.find(item => item.id === nodeId);
  if (!node) throw new Error('Selected ruin node does not exist');
  if (node.kind !== 'anomaly' || !node.enterable) {
    throw new Error('Only an enterable anomaly can be selected');
  }
  return { candidates: record.result, candidate, node };
}
