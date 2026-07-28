import type { GenerationSettings } from './settings.ts';
import type {
  GenerationTaskType,
  WorkbenchSettings,
} from './workbenchSettings.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import type { GenealogyGenerationInput } from '../schemas/genealogy.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import type { ButterflyRecord } from '../storage/butterflies.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { RuinCandidateRecord } from '../storage/ruins.ts';

export const WORKBENCH_GLOBAL = 'EyonHistoryWorkbench';
export const WORKBENCH_STATUS_EVENT = 'eyon-history-workbench:status';
export const WORKBENCH_READY_EVENT = 'eyon-history-workbench:ready';

export interface WorkbenchStatusDetail {
  status: string;
  detail: string;
}

export interface EyonHistoryWorkbenchFacade {
  version: string;
  getSettings(): WorkbenchSettings;
  updateSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings;
  setGenerationSettings(
    taskType: GenerationTaskType,
    settings: GenerationSettings,
  ): WorkbenchSettings;
  applyGenerationSettingsToAll(
    settings: GenerationSettings,
  ): WorkbenchSettings;
  setRuinDraft(input: RuinGenerationInput | null): WorkbenchSettings;
  generateGenealogy(input: GenealogyGenerationInput): Promise<GenealogyRecord>;
  listGenealogies(): Promise<GenealogyRecord[]>;
  generateRuin(input: RuinGenerationInput): Promise<RuinCandidateRecord>;
  listRuins(): Promise<RuinCandidateRecord[]>;
  listBiographies(): Promise<BiographyRecord[]>;
  listButterflies(): Promise<ButterflyRecord[]>;
  enterRuin(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<unknown>;
  returnRuin(): Promise<unknown>;
  retryButterfly(runId: string): Promise<unknown>;
  dispose(): void;
}
