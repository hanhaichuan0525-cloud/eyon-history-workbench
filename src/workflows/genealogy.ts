import type { GenerationAdapter } from '../adapters/host.ts';
import type { GenealogyContextAssembler } from '../core/context.ts';
import type { WorkbenchCommand } from '../core/commands.ts';
import type { WorkbenchNamespace } from '../core/namespace.ts';
import { namespaceKey } from '../core/namespace.ts';
import {
  buildGenealogyApiPrompt,
  buildGenealogyRepairPrompt,
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
import {
  GenealogyValidationError,
  parseAndValidateGenealogy,
} from '../validators/genealogy.ts';
import {
  buildArtifactCanonBindingsSafely,
  genealogyBindingUnits,
} from '../core/artifactCanonBinding.ts';
import { buildGenealogyEvidenceRoster, captureGenealogyLocalEvidence } from '../core/genealogyEvidence.ts';
import type { CanonRepository } from '../storage/canon.ts';

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
  canonRepository?: CanonRepository;
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
    const validationWarnings: string[] = [];
    const onWarning = (warning: string) => { if (validationWarnings.length < 64) validationWarnings.push(warning); };
    let result;
    try {
      result = parseAndValidateGenealogy(rawResult, {
        onWarning,
        requestId,
        input,
        context,
        directive: command.raw || `宗族谱系 ${input.focusCharacter.name}`,
      });
    } catch (error) {
      if (!isRepairableGenealogyError(error)) throw error;
      const repairPrompt = buildGenealogyRepairPrompt({
        validationError: summarizeValidationError(error),
        requestId,
        directive: command.raw || `宗族谱系 ${input.focusCharacter.name}`,
        generationInput: input,
        context,
        rules: this.dependencies.rules,
      });
      const repairedResult = await this.dependencies.generator.generate(
        'genealogy',
        repairPrompt,
      );
      result = parseAndValidateGenealogy(repairedResult, {
        onWarning,
        requestId,
        input,
        context,
        directive: command.raw || `宗族谱系 ${input.focusCharacter.name}`,
      });
    }

    await this.dependencies.assertCurrent(identity);
    const createdAt = this.dependencies.now();
    const canonBindings = buildArtifactCanonBindingsSafely({
      artifactType: 'genealogy',
      artifactId: requestId,
      view: context.evidenceBundle.canonResolvedView,
      branch: await loadCanonBranchSafely(
        this.dependencies.canonRepository,
        identity.namespace,
      ),
      units: genealogyBindingUnits(
        result,
        buildGenealogyEvidenceRoster(input, context),
      ),
      createdAt,
    });
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
      localEvidence: captureGenealogyLocalEvidence(result, context),
      ...(validationWarnings.length ? { validationWarnings } : {}),
      ...(canonBindings.length > 0 ? { canonBindings } : {}),
      createdAt,
    };
    await this.dependencies.repository.save(record);
    return record;
  }
}

async function loadCanonBranchSafely(
  repository: CanonRepository | undefined,
  namespace: WorkbenchNamespace,
) {
  if (!repository) return undefined;
  try {
    return await repository.getBranch(namespace);
  } catch {
    return undefined;
  }
}

function isRepairableGenealogyError(
  error: unknown,
): error is GenealogyValidationError {
  if (!(error instanceof GenealogyValidationError)) return false;
  return [
    'JSON_PARSE_FAILED',
    'SCHEMA_INVALID',
    'CONTEXT_ECHO',
    'REQUEST_MISMATCH',
    'FOCUS_MISMATCH',
    'DEPTH_MISMATCH',
    'PROFILE_REQUIRED',
    'CHRONOLOGY_INVALID',
  ].includes(error.code);
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function summarizeValidationError(error: GenealogyValidationError): string {
  if (error.code === 'CONTEXT_ECHO') return `${error.code}: ${error.message}`;
  if (['PROFILE_REQUIRED', 'CHRONOLOGY_INVALID'].includes(error.code)) {
    return `${error.code}: ${error.message}`;
  }
  return `${error.code}: 上一次结果不符合 eyon.genealogy.v2 的固定结构`;
}
