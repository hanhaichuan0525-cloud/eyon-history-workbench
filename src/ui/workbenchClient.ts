import {
  WORKBENCH_DATA_CHANGED_EVENT,
  WORKBENCH_GLOBAL,
  WORKBENCH_READY_EVENT,
  WORKBENCH_RUIN_REFERENCES_EVENT,
  WORKBENCH_STATUS_EVENT,
  type EyonHistoryWorkbenchFacade,
  type WorkbenchDataChangedDetail,
  type WorkbenchStatusDetail,
} from '../runtime/facade.ts';
import type { GenerationSettings } from '../runtime/settings.ts';
import type {
  GenerationTaskType,
  WorkbenchSettings,
} from '../runtime/workbenchSettings.ts';
import type { RuinRuntimeSnapshot } from '../adapters/host.ts';

export interface WorkbenchUiSnapshot {
  version: string;
  settings: ReturnType<EyonHistoryWorkbenchFacade['getSettings']>;
  runtime: RuinRuntimeSnapshot;
  biographies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listBiographies']>>;
  genealogies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listGenealogies']>>;
  ruins: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listRuins']>>;
  butterflies: Awaited<ReturnType<EyonHistoryWorkbenchFacade['listButterflies']>>;
}

const EXTENSION_SETTINGS_KEY = 'eyon-history-workbench';
const SETTINGS_CHANGED_EVENT = 'eyon-history-workbench:settings-changed';

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

  /**
   * The launcher is intentionally usable before the runtime facade is ready.
   * This is the narrow host-settings fallback used by the settings banner; all
   * other settings still require the real facade.
   */
  isWorkbenchEnabled(): boolean {
    const facade = this.globals[WORKBENCH_GLOBAL];
    if (isFacade(facade)) return facade.getSettings().workbenchEnabled !== false;
    const value = readExtensionSettings(this.globals)?.[EXTENSION_SETTINGS_KEY];
    return !isRecord(value) || value.workbenchEnabled !== false;
  }

  facade(): EyonHistoryWorkbenchFacade {
    const facade = this.globals[WORKBENCH_GLOBAL];
    if (!isFacade(facade)) {
      throw new Error('伊雍历史工作台尚未完成初始化');
    }
    return facade;
  }

  resolveDisplayText(text: string): string {
    return this.facade().resolveDisplayText?.(text)
      ?? text.replace(/玩家/gu, '<user>');
  }

  async readSnapshot(): Promise<WorkbenchUiSnapshot> {
    const facade = this.facade();
    const [
      runtime,
      biographies,
      genealogies,
      ruins,
      butterflies,
    ] = await Promise.all([
      facade.getRuinRuntimeSnapshot(),
      facade.listBiographies(),
      facade.listGenealogies(),
      facade.listRuins(),
      facade.listButterflies(),
    ]);
    return {
      version: facade.version,
      settings: facade.getSettings(),
      runtime,
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

  updateSettings(
    patch: Parameters<EyonHistoryWorkbenchFacade['updateSettings']>[0],
  ): WorkbenchSettings | Pick<WorkbenchSettings, 'workbenchEnabled'> {
    const facade = this.globals[WORKBENCH_GLOBAL];
    if (isFacade(facade)) return facade.updateSettings(patch);
    if (!Object.prototype.hasOwnProperty.call(patch, 'workbenchEnabled')) {
      return this.facade().updateSettings(patch);
    }
    const extensionSettings = readExtensionSettings(this.globals, true);
    if (!extensionSettings) {
      throw new Error('SillyTavern.extensionSettings 不可用');
    }
    const enabled = patch.workbenchEnabled === true;
    extensionSettings[EXTENSION_SETTINGS_KEY] = {
      ...(isRecord(extensionSettings[EXTENSION_SETTINGS_KEY])
        ? extensionSettings[EXTENSION_SETTINGS_KEY]
        : {}),
      workbenchEnabled: enabled,
    };
    const host = isRecord(this.globals.SillyTavern)
      ? this.globals.SillyTavern
      : null;
    const context = typeof host?.getContext === 'function'
      ? host.getContext() as Record<string, unknown>
      : null;
    const saveSettingsDebounced = context?.saveSettingsDebounced
      ?? host?.saveSettingsDebounced;
    if (typeof saveSettingsDebounced === 'function') {
      void (saveSettingsDebounced as () => Promise<void> | void)();
    }
    this.events.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, {
      detail: { workbenchEnabled: enabled },
    }));
    return { workbenchEnabled: enabled };
  }

  listGenealogyCharacters() {
    return this.facade().listGenealogyCharacters();
  }

  listCharacterWorldbookEntries() {
    return this.facade().listCharacterWorldbookEntries();
  }

  setCharacterWorldbookEntryEnabled(entryKey: string, enabled: boolean) {
    return this.facade().setCharacterWorldbookEntryEnabled(entryKey, enabled);
  }

  setCharacterWorldbookEntriesEnabled(entryKeys: string[], enabled: boolean) {
    return this.facade().setCharacterWorldbookEntriesEnabled(entryKeys, enabled);
  }

  async generateGenealogy(
    input: Parameters<EyonHistoryWorkbenchFacade['generateGenealogy']>[0],
  ) {
    const record = await this.facade().generateGenealogy(input);
    this.publishDataChanged({
      views: ['genealogy', 'ruin'],
      reason: 'genealogy-generated',
    });
    return record;
  }

  listGenealogies() {
    return this.facade().listGenealogies();
  }

  listBiographies() {
    return this.facade().listBiographies();
  }

  deleteBiography(recordKey: string) {
    return this.facade().deleteBiography(recordKey);
  }

  listRuinBiographyReferences() {
    return this.facade().listRuinBiographyReferences();
  }

  toggleBiographyRuinReference(recordKey: string) {
    return this.facade().toggleBiographyRuinReference(recordKey);
  }

  removeRuinBiographyReference(referenceId: string) {
    return this.facade().removeRuinBiographyReference(referenceId);
  }

  listButterflies() {
    return this.facade().listButterflies();
  }

  listButterflyPending() {
    return this.facade().listButterflyPending();
  }

  deleteButterfly(runId: string) {
    return this.facade().deleteButterfly(runId);
  }

  /** internal.87：清理旧版蝴蝶镜像世界书（摘全局绑定 + 删镜像条目）。 */
  retireButterflyMirrors() {
    return this.facade().retireButterflyMirrors();
  }

  inspectCurrentArtifactCanonConsumption() {
    return this.facade().inspectCurrentArtifactCanonConsumption();
  }

  async inspectCurrentContinuityAnchors() {
    const inspect = this.facade().inspectCurrentContinuityAnchors;
    if (!inspect) throw new Error('当前脚本版本不支持连续性关系诊断');
    return inspect();
  }

  /** internal.86：蝴蝶记忆注入通道快照（诊断面板）。 */
  inspectCanonMemory() {
    return this.facade().inspectCanonMemory();
  }

  /** internal.86：手动重算并重新注入。 */
  refreshCanonMemory() {
    return this.facade().refreshCanonMemory();
  }

  inspectCurrentData() {
    return this.facade().inspectCurrentData();
  }

  exportCurrentData() {
    return this.facade().exportCurrentData();
  }

  async clearGenerationCache() {
    const result = await this.facade().clearGenerationCache();
    this.publishRuinReferences([]);
    this.publishDataChanged({
      views: ['genealogy', 'ruin', 'settings'],
      reason: 'cache-cleared',
    });
    return result;
  }

  clearErrorLog() {
    return this.facade().clearErrorLog();
  }

  getRuinPresenceDiagnostics() {
    return this.facade().getRuinPresenceDiagnostics();
  }

  getRuinRuntimeSnapshot() {
    return this.facade().getRuinRuntimeSnapshot();
  }

  returnRuin() {
    return this.facade().returnRuin();
  }

  retryButterfly(runId: string) {
    return this.facade().retryButterfly(runId);
  }

  listRuinCharacterReferences() {
    return this.facade().listRuinCharacterReferences();
  }

  setRuinDraft(
    input: Parameters<EyonHistoryWorkbenchFacade['setRuinDraft']>[0],
  ) {
    return this.facade().setRuinDraft(input);
  }

  async generateRuin(
    input: Parameters<EyonHistoryWorkbenchFacade['generateRuin']>[0],
  ) {
    const record = await this.facade().generateRuin(input);
    this.publishDataChanged({ views: ['ruin'], reason: 'ruin-generated' });
    return record;
  }

  listRuins() {
    return this.facade().listRuins();
  }

  async retryRuinCandidate(recordKey: string, candidateId: string) {
    const facade = this.facade();
    if (typeof facade.retryRuinCandidate !== 'function') {
      throw new Error('当前脚本版本不支持单项墟境重试，请重新载入最新版脚本');
    }
    const record = await facade.retryRuinCandidate(recordKey, candidateId);
    this.publishDataChanged({
      views: ['ruin'], reason: 'ruin-candidate-retried',
    });
    return record;
  }

  enterRuin(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ) {
    return this.facade().enterRuin(recordKey, candidateId, nodeId);
  }

  getRuinTaskReview() {
    return this.facade().getRuinTaskReview();
  }

  generateRuinTaskDraft(
    request: Parameters<EyonHistoryWorkbenchFacade['generateRuinTaskDraft']>[0],
  ) {
    return this.facade().generateRuinTaskDraft(request);
  }

  updateRuinTaskDraft(
    patch: Parameters<EyonHistoryWorkbenchFacade['updateRuinTaskDraft']>[0],
  ) {
    return this.facade().updateRuinTaskDraft(patch);
  }

  async confirmRuinTaskDraft() {
    const submission = await this.facade().confirmRuinTaskDraft();
    this.publishDataChanged({ views: ['ruin'], reason: 'ruin-task-requested' });
    return submission;
  }

  async toggleGenealogyNodeRuinReference(
    genealogyRecordKey: string,
    nodeId: string,
  ) {
    const references = await this.facade().toggleGenealogyNodeRuinReference(
      genealogyRecordKey,
      nodeId,
    );
    this.publishRuinReferences(references);
    this.publishDataChanged({
      views: ['genealogy', 'ruin'],
      reason: 'ruin-references',
    });
    return references;
  }

  async removeRuinCharacterReference(referenceId: string) {
    const references = await this.facade().removeRuinCharacterReference(referenceId);
    this.publishRuinReferences(references);
    this.publishDataChanged({
      views: ['genealogy', 'ruin'],
      reason: 'ruin-references',
    });
    return references;
  }

  fetchCustomApiModels(apiurl: string, key: string) {
    return this.facade().fetchCustomApiModels(apiurl, key);
  }

  onRuinReferences(
    listener: (references: Awaited<ReturnType<
      EyonHistoryWorkbenchFacade['listRuinCharacterReferences']
    >>) => void,
  ): () => void {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent) || !Array.isArray(event.detail)) return;
      listener(event.detail);
    };
    this.events.addEventListener(WORKBENCH_RUIN_REFERENCES_EVENT, handler);
    return () => this.events.removeEventListener(
      WORKBENCH_RUIN_REFERENCES_EVENT,
      handler,
    );
  }

  onDataChanged(
    listener: (detail: WorkbenchDataChangedDetail) => void,
  ): () => void {
    const handler = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isDataChangedDetail(event.detail)) {
        return;
      }
      listener(event.detail);
    };
    this.events.addEventListener(WORKBENCH_DATA_CHANGED_EVENT, handler);
    return () => this.events.removeEventListener(
      WORKBENCH_DATA_CHANGED_EVENT,
      handler,
    );
  }

  setGenealogyDepth(
    ancestors: number,
    descendants: number,
    maxPerGeneration: number,
  ) {
    return this.facade().updateSettings({
      genealogyDepth: { ancestors, descendants, maxPerGeneration },
    });
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

  private publishRuinReferences(
    references: Awaited<ReturnType<
      EyonHistoryWorkbenchFacade['listRuinCharacterReferences']
    >>,
  ): void {
    this.events.dispatchEvent(new CustomEvent(WORKBENCH_RUIN_REFERENCES_EVENT, {
      detail: structuredClone(references),
    }));
  }

  private publishDataChanged(detail: WorkbenchDataChangedDetail): void {
    this.events.dispatchEvent(new CustomEvent(WORKBENCH_DATA_CHANGED_EVENT, {
      detail: structuredClone(detail),
    }));
  }
}

function isFacade(value: unknown): value is EyonHistoryWorkbenchFacade {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<EyonHistoryWorkbenchFacade>;
  return (
    typeof candidate.version === 'string'
    && typeof candidate.getSettings === 'function'
    && typeof candidate.getRuinRuntimeSnapshot === 'function'
    && typeof candidate.setGenerationSettings === 'function'
    && typeof candidate.listGenealogyCharacters === 'function'
    && typeof candidate.listCharacterWorldbookEntries === 'function'
    && typeof candidate.setCharacterWorldbookEntryEnabled === 'function'
    && typeof candidate.setCharacterWorldbookEntriesEnabled === 'function'
    && typeof candidate.generateRuin === 'function'
    && typeof candidate.generateGenealogy === 'function'
    && typeof candidate.removeRuinCharacterReference === 'function'
    && typeof candidate.fetchCustomApiModels === 'function'
    && typeof candidate.deleteButterfly === 'function'
    && typeof candidate.inspectCurrentData === 'function'
    && typeof candidate.exportCurrentData === 'function'
    && typeof candidate.clearGenerationCache === 'function'
    && typeof candidate.clearErrorLog === 'function'
    && typeof candidate.enterRuin === 'function'
    && typeof candidate.getRuinTaskReview === 'function'
    && typeof candidate.generateRuinTaskDraft === 'function'
    && typeof candidate.updateRuinTaskDraft === 'function'
    && typeof candidate.confirmRuinTaskDraft === 'function'
    && typeof candidate.returnRuin === 'function'
  );
}

function readExtensionSettings(
  globals: Record<string, unknown>,
  create = false,
): Record<string, unknown> | null {
  const host = isRecord(globals.SillyTavern) ? globals.SillyTavern : null;
  const context = typeof host?.getContext === 'function'
    ? host.getContext() as Record<string, unknown>
    : null;
  const fromContext = context?.extensionSettings;
  if (isRecord(fromContext)) return fromContext;
  const fromHost = host?.extensionSettings;
  if (isRecord(fromHost)) return fromHost;
  return create ? null : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStatusDetail(value: unknown): value is WorkbenchStatusDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<WorkbenchStatusDetail>;
  return typeof detail.status === 'string' && typeof detail.detail === 'string';
}

function isDataChangedDetail(value: unknown): value is WorkbenchDataChangedDetail {
  if (!value || typeof value !== 'object') return false;
  const detail = value as Partial<WorkbenchDataChangedDetail>;
  return Array.isArray(detail.views) && typeof detail.reason === 'string';
}
