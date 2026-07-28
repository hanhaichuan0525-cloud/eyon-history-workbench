import { BiographyController } from './runtime/biographyController.ts';
import { TavernBiographyContextAssembler } from './runtime/biographyContext.ts';
import {
  createGlobalDataBindings,
  createGlobalEventBridge,
  createGlobalScriptVariableBindings,
} from './runtime/globalBindings.ts';
import { registerWorkbenchLifecycle } from './runtime/registerLifecycle.ts';
import {
  createRuinIdentityAssertion,
  RuinController,
  RuinTransactionGuard,
} from './runtime/ruinController.ts';
import { TavernRuinContextAssembler } from './runtime/ruinContext.ts';
import {
  embeddedBiographyRules,
  embeddedRuinRules,
} from './runtime/ruleBundle.ts';
import { TavernBiographyShellAdapter } from './runtime/tavernBiographyShell.ts';
import { TavernGenerationAdapter } from './runtime/tavernGeneration.ts';
import {
  SerializedTavernUserTurnAdapter,
  TavernContextSourceProvider,
  TavernWorkbenchHost,
} from './runtime/tavernHost.ts';
import { createGlobalTavernRuntime } from './runtime/tavernRuntimeAdapter.ts';
import { TavernScopeReader } from './runtime/tavernScope.ts';
import {
  ScriptWorkbenchSettings,
  type WorkbenchSettings,
} from './runtime/workbenchSettings.ts';
import { WorkbenchLifecycle } from './runtime/workbenchLifecycle.ts';
import { IndexedDbBiographyRepository } from './storage/indexedDbBiographies.ts';
import {
  IndexedDbRuinCandidateRepository,
  type RuinCandidateRecord,
} from './storage/ruins.ts';
import type { RuinGenerationInput } from './schemas/ruin.ts';
import { BiographyWorkflow } from './workflows/biography.ts';
import { RuinWorkflow } from './workflows/ruin.ts';
import { RuinEntryWorkflow } from './workflows/ruinEntry.ts';

const GLOBAL_FACADE = 'EyonHistoryWorkbench';
const STATUS_EVENT = 'eyon-history-workbench:status';
const READY_EVENT = 'eyon-history-workbench:ready';

export interface EyonHistoryWorkbenchFacade {
  version: string;
  getSettings(): WorkbenchSettings;
  updateSettings(patch: Partial<WorkbenchSettings>): WorkbenchSettings;
  setRuinDraft(input: RuinGenerationInput | null): WorkbenchSettings;
  generateRuin(input: RuinGenerationInput): Promise<RuinCandidateRecord>;
  listRuins(): Promise<RuinCandidateRecord[]>;
  listBiographies(): Promise<unknown[]>;
  enterRuin(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<unknown>;
  dispose(): void;
}

let disposeCurrent: (() => void) | null = null;

async function bootstrap(): Promise<void> {
  disposeCurrent?.();
  const globalObject = globalThis as Record<string, unknown>;
  const runtime = createGlobalTavernRuntime(globalObject);
  const dataBindings = createGlobalDataBindings(globalObject);
  const settings = new ScriptWorkbenchSettings(
    createGlobalScriptVariableBindings(globalObject),
  );
  const biographies = new IndexedDbBiographyRepository();
  const ruins = new IndexedDbRuinCandidateRepository();
  const host = new TavernWorkbenchHost(runtime, dataBindings);
  const sources = new TavernContextSourceProvider(
    dataBindings,
    biographies,
    () => scopeReader.getNamespace(),
  );
  const scopeReader = new TavernScopeReader(runtime, () =>
    latestVisibleUserMessageId(runtime));
  const generator = new TavernGenerationAdapter(
    runtime,
    settings,
    () => crypto.randomUUID(),
  );
  const biographyShell = new TavernBiographyShellAdapter(runtime);
  const biographyWorkflow = new BiographyWorkflow({
    contextAssembler: new TavernBiographyContextAssembler(runtime, sources),
    generator,
    shell: biographyShell,
    repository: biographies,
    rules: embeddedBiographyRules,
    getScope: async () => scopeReader.getScope(),
    createRequestId: () => crypto.randomUUID(),
    now: Date.now,
  });
  const biographyController = new BiographyController(
    biographyWorkflow,
    biographyShell,
    runtime,
    async () => scopeReader.getScope(),
    { onStatus: emitStatus },
  );
  const ruinGuard = new RuinTransactionGuard();
  const ruinWorkflow = new RuinWorkflow({
    contextAssembler: new TavernRuinContextAssembler(runtime, sources),
    generator,
    repository: ruins,
    rules: embeddedRuinRules,
    createRequestId: () => crypto.randomUUID(),
    now: Date.now,
    assertCurrent: createRuinIdentityAssertion(runtime, ruinGuard),
  });
  const ruinController = new RuinController(
    ruinWorkflow,
    runtime,
    { onStatus: emitStatus },
    ruinGuard,
  );
  const ruinEntry = new RuinEntryWorkflow({
    repository: ruins,
    host,
    userTurns: new SerializedTavernUserTurnAdapter(runtime, dataBindings),
  });
  const lifecycle = new WorkbenchLifecycle({
    biography: biographyController,
    ruin: ruinController,
    ruinInputProvider: settings,
    runtime,
  });
  const events = createGlobalEventBridge(globalObject);
  const registration = registerWorkbenchLifecycle(
    lifecycle,
    events.bridge,
    events.names,
    globalObject,
  );
  const facade: EyonHistoryWorkbenchFacade = {
    version: '0.5.0',
    getSettings: () => settings.read(),
    updateSettings: patch => settings.update(patch),
    setRuinDraft: input => settings.update({ ruinDraft: input }),
    generateRuin: input => ruinController.generateFromPanel(input),
    listRuins: async () => ruins.list(scopeReader.getNamespace()),
    listBiographies: async () => biographies.list(scopeReader.getNamespace()),
    enterRuin: (recordKey, candidateId, nodeId) =>
      ruinEntry.enter(recordKey, candidateId, nodeId),
    dispose() {
      registration.dispose();
      if (globalObject[GLOBAL_FACADE] === facade) {
        delete globalObject[GLOBAL_FACADE];
      }
    },
  };
  globalObject[GLOBAL_FACADE] = facade;
  disposeCurrent = () => facade.dispose();
  globalThis.dispatchEvent(new CustomEvent(READY_EVENT, { detail: facade }));
  emitStatus('ready', '伊雍历史工作台已就绪');
}

function latestVisibleUserMessageId(
  runtime: ReturnType<typeof createGlobalTavernRuntime>,
): number {
  const last = runtime.getLastMessageId();
  const messages = runtime.getChatMessages(`0-${last}`, {
    include_swipes: false,
  });
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && !message.is_hidden) return message.message_id;
  }
  throw new Error('当前聊天没有可用的玩家楼');
}

function emitStatus(status: string, detail?: string): void {
  globalThis.dispatchEvent(new CustomEvent(STATUS_EVENT, {
    detail: { status, detail: detail ?? '' },
  }));
}

function start(): void {
  void bootstrap().catch(error => {
    console.error('[Eyon History Workbench] bootstrap failed', error);
    emitStatus('failed', error instanceof Error ? error.message : String(error));
  });
}

const globalRecord = globalThis as Record<string, unknown>;
const jquery = globalRecord.$;
if (typeof jquery === 'function') {
  (jquery as (ready: () => void) => void)(start);
} else {
  start();
}

globalThis.addEventListener('pagehide', () => {
  disposeCurrent?.();
  disposeCurrent = null;
}, { once: true });
