import {
  WORKBENCH_GLOBAL,
  WORKBENCH_READY_EVENT,
  WORKBENCH_STATUS_EVENT,
  type EyonHistoryWorkbenchFacade,
  type WorkbenchStatusDetail,
} from '../runtime/facade.ts';
import type { GenerationSettings } from '../runtime/settings.ts';
import type { GenerationTaskType } from '../runtime/workbenchSettings.ts';

export interface WorkbenchUiSnapshot {
  version: string;
  settings: ReturnType<EyonHistoryWorkbenchFacade['getSettings']>;
  biographies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listBiographies']>>;
  genealogies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listGenealogies']>>;
  ruins: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listRuins']>>;
  butterflies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listButterflies']>>;
}

export class WorkbenchUiClient {
  private readonly globals: Record<string, unknown>;
  private readonly events: EventTarget;

  constructor(
    globals: Record<string, unknown> = globalThis as Record<string, unknown>,
    events: EventTarget = globalThis,
  ) {
    this.globals = globals;
    this.events = events;
  }

  isReady(): boolean {
    return isFacade(this.globals[WORKBENCH_GLOBAL]);
  }

  facade(): EyonHistoryWorkbenchFacade {
    const facade = this.globals[WORKBENCH_GLOBAL];
    if (!isFacade(facade)) {
      throw new Error('伊雍历史工作台尚未完成初始化');
    }
    return facade;
  }

  async readSnapshot(): Promise<WorkbenchUiSnapshot> {
    const facade = this.facade();
    const [biographies, genealogies, ruins, butterflies] = await Promise.all([
      facade.listBiographies(),
      facade.listGenealogies(),
      facade.listRuins(),
      facade.listButterflies(),
    ]);
    return {
      version: facade.version,
      settings: facade.getSettings(),
      biographies,
      genealogies,
      ruins,
      butterflies,
    };
  }

  setGeneration(
    taskType: GenerationTaskType,
    settings: GenerationSettings,
  ) {
    return this.facade().setGenerationSettings(taskType, settings);
  }

  applyGenerationToAll(settings: GenerationSettings) {
    return this.facade().applyGenerationSettingsToAll(settings);
  }

  onStatus(listener: (detail: WorkbenchStatusDetail) => void): () => void {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (!isStatusDetail(event.detail)) return;
      listener(event.detail);
    };
    this.events.addEventListener(WORKBENCH_STATUS_EVENT, handler);
    return () => this.events.removeEventListener(WORKBENCH_STATUS_EVENT, handler);
  }

  onReady(listener: (facade: EyonHistoryWorkbenchFacade) => void): () => void {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      if (!isFacade(event.detail)) return;
      listener(event.detail);
    };
    this.events.addEventListener(WORKBENCH_READY_EVENT, handler);
    return () => this.events.removeEventListener(WORKBENCH_READY_EVENT, handler);
  }
}

function isFacade(value: unknown): value is EyonHistoryWorkbenchFacade {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EyonHistoryWorkbenchFacade>;
  return (
    typeof candidate.version === 'string'
    && typeof candidate.getSettings === 'function'
    && typeof candidate.setGenerationSettings === 'function'
    && typeof candidate.generateRuin === 'function'
    && typeof candidate.generateGenealogy === 'function'
    && typeof candidate.enterRuin === 'function'
    && typeof candidate.returnRuin === 'function'
  );
}

function isStatusDetail(value: unknown): value is WorkbenchStatusDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<WorkbenchStatusDetail>;
  return typeof detail.status === 'string' && typeof detail.detail === 'string';
}
