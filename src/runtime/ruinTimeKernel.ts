import type { RuntimeChatMessage, TavernRuntime } from './contracts.ts';
import type { TavernDataBindings } from './tavernHost.ts';
import { parseTextCommand } from '../core/commands.ts';

type Variables = Record<string, unknown>;
type RuntimeState = Record<string, unknown>;
type PatchOperation = {
  op: string;
  path: string;
  value?: unknown;
};

const ACTIVE_FLOWS = new Set(['exploring', 'anchored', 'returning']);
/**
 * 时间内核接受的运行状态字段白名单(单一真源)。
 * 进入特异点注入的变量更新规则段据此生成/校验,禁止与注入文本漂移。
 */
export const RUNTIME_FIELDS = new Set([
  '墟境流程状态',
  '墟境任务规则锁定',
  '墟境待遣返',
  '墟境待蝴蝶效应结算',
  '墟境轮次',
  '墟境进入前时间',
  '墟境进入前地点',
  '本轮现实时间',
  '本轮现实地点',
  '墟境当前时间',
  '墟境当前地点',
  '本轮墟境进入时间',
  '本轮墟境进入地点',
  '本轮墟境离开时间',
  '本轮墟境离开地点',
  '归档轮次',
  '归档现实时间',
  '归档现实地点',
  '归档墟境进入时间',
  '归档墟境进入地点',
  '归档墟境离开时间',
  '归档墟境离开地点',
  '蝴蝶效应锚定计数',
]);

const SAME_RUN_LOCKED_FIELDS = [
  '墟境进入前时间',
  '墟境进入前地点',
  '本轮现实时间',
  '本轮现实地点',
  '本轮墟境进入时间',
  '本轮墟境进入地点',
] as const;

const ACTIVE_CARRY_FIELDS = [
  '墟境流程状态',
  '墟境任务规则锁定',
  '墟境待遣返',
  '墟境待蝴蝶效应结算',
  '墟境轮次',
  ...SAME_RUN_LOCKED_FIELDS,
  '墟境当前时间',
  '墟境当前地点',
  '本轮墟境离开时间',
  '本轮墟境离开地点',
] as const;

const DEFAULT_RUNTIME: RuntimeState = {
  墟境流程状态: 'idle',
  墟境任务规则锁定: 0,
  墟境待遣返: 0,
  墟境待蝴蝶效应结算: 0,
  墟境轮次: '',
  墟境进入前时间: '',
  墟境进入前地点: '',
  本轮现实时间: '',
  本轮现实地点: '',
  墟境当前时间: '',
  墟境当前地点: '',
  本轮墟境进入时间: '',
  本轮墟境进入地点: '',
  本轮墟境离开时间: '',
  本轮墟境离开地点: '',
  归档轮次: '',
  归档现实时间: '',
  归档现实地点: '',
  归档墟境进入时间: '',
  归档墟境进入地点: '',
  归档墟境离开时间: '',
  归档墟境离开地点: '',
  蝴蝶效应锚定计数: 0,
};

export interface RuinTimeKernelRegistration {
  dispose(): void;
}

interface KernelEventSubscription {
  stop?: () => void;
}

export function registerRuinTimeKernel(
  runtime: TavernRuntime,
  bindings: TavernDataBindings,
  globalObject: Record<string, unknown> = globalThis as Record<string, unknown>,
): RuinTimeKernelRegistration {
  const mvu = asRecord(globalObject.Mvu);
  const events = asRecord(mvu.events);
  const eventOn = typeof globalObject.eventOn === 'function'
    ? globalObject.eventOn as (
        event: string,
        listener: (...args: unknown[]) => void,
      ) => KernelEventSubscription | void
    : null;
  const subscriptions: KernelEventSubscription[] = [];
  let disposed = false;
  let saving = false;
  let lastCarriedUserId = -1;
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  const previousAssistant = (messageId: number): RuntimeChatMessage | null => {
    const messages = runtime.getChatMessages(
      `0-${Math.max(-1, messageId - 1)}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.is_hidden) continue;
      if (message.role === 'assistant') return message;
    }
    return null;
  };

  const returnAuthorized = (messageId: number): boolean => {
    const messages = runtime.getChatMessages(
      `0-${Math.max(-1, messageId - 1)}`,
      { include_swipes: false },
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.is_hidden) continue;
      if (message.role !== 'user') continue;
      return parseTextCommand(message.message)?.type === 'ruin.return';
    }
    return false;
  };

  const normalizeMessage = async (
    messageId: number,
    variables?: Variables,
    text?: string,
  ): Promise<boolean> => {
    if (disposed || saving || messageId < 0) return false;
    const message = runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (!message || message.is_hidden) return false;
    const getMessage = bindings.getMessageVariables;
    const replaceMessage = bindings.replaceMessageVariables;
    if (!getMessage || !replaceMessage) return false;

    const current = structuredClone(variables ?? getMessage(messageId) ?? {});
    let changed = false;
    if (message.role === 'user') {
      const previous = previousAssistant(messageId);
      if (!previous) return false;
      const prior = getMessage(previous.message_id);
      changed = carryPlayerFloor(current, prior);
    } else if (message.role === 'assistant') {
      const previous = previousAssistant(messageId);
      const prior = previous ? getMessage(previous.message_id) : null;
      changed = normalizeRuinVariables(
        current,
        prior,
        text ?? message.message,
        returnAuthorized(messageId),
      );
    }
    if (!changed) return true;
    saving = true;
    try {
      await replaceMessage(messageId, current);
    } finally {
      saving = false;
    }
    return true;
  };

  const scheduleNormalize = (
    messageId: number,
    text?: string,
    delays = [0, 90, 240, 520, 900],
  ) => {
    delays.forEach(delay => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        void normalizeMessage(messageId, undefined, text).catch(error => {
          console.warn('[Eyon History Workbench] time kernel replay failed', error);
        });
      }, delay);
      pendingTimers.add(timer);
    });
  };

  const subscribe = (eventName: unknown, listener: (...args: unknown[]) => void) => {
    if (!eventOn || typeof eventName !== 'string' || !eventName) return;
    const subscription = eventOn(eventName, listener);
    if (subscription) subscriptions.push(subscription);
  };

  subscribe(events.COMMAND_PARSED, (...args) => {
    const commands = args.find(Array.isArray);
    const text = args.find(value => typeof value === 'string');
    if (!Array.isArray(commands) || typeof text !== 'string') return;
    strengthenEntryCommands(
      commands as Array<Record<string, unknown>>,
      text,
    );
  });

  subscribe(events.BEFORE_MESSAGE_UPDATE, (...args) => {
    const event = args.find(value => isRecord(value));
    if (!event) return;
    const messageId = runtime.getLastMessageId();
    const variables = isRecord(event.variables) ? event.variables : undefined;
    const text = typeof event.message_content === 'string'
      ? event.message_content
      : undefined;
    if (variables) normalizeRuinVariables(
      variables,
      previousVariables(runtime, bindings, messageId),
      text ?? '',
      returnAuthorized(messageId),
    );
    scheduleNormalize(messageId, text);
  });

  subscribe(events.VARIABLE_UPDATE_ENDED, (...args) => {
    const variables = args.find(value => isRecord(value));
    const messageId = runtime.getLastMessageId();
    const message = runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (variables && message?.role === 'assistant') {
      normalizeRuinVariables(
        variables,
        previousVariables(runtime, bindings, messageId),
        message.message,
        returnAuthorized(messageId),
      );
    }
    scheduleNormalize(messageId, message?.message);
  });

  const carryWatcher = setInterval(() => {
    if (disposed) return;
    const messageId = runtime.getLastMessageId();
    const message = runtime
      .getChatMessages(messageId, { include_swipes: false })
      .find(item => item.message_id === messageId);
    if (
      !message
      || message.role !== 'user'
      || message.is_hidden
      || messageId === lastCarriedUserId
    ) return;
    lastCarriedUserId = messageId;
    scheduleNormalize(messageId, message.message, [40, 140, 340, 700]);
  }, 400);

  scheduleNormalize(runtime.getLastMessageId());

  return {
    dispose() {
      disposed = true;
      clearInterval(carryWatcher);
      pendingTimers.forEach(clearTimeout);
      pendingTimers.clear();
      subscriptions.forEach(subscription => subscription.stop?.());
    },
  };
}

export function normalizeRuinVariables(
  variables: Variables,
  previousVariablesValue: Variables | null,
  assistantText: string,
  returnAuthorized = false,
): boolean {
  const stat = ensureRecord(variables, 'stat_data');
  const root = ensureRecord(stat, '墟境系统');
  ensureRuntime(root);
  const previousState = runtimeState(previousVariablesValue);
  const operations = extractRuinPatchOperations(assistantText);
  let changed = applyPatchOperations(stat, operations);
  const refreshedRoot = ensureRecord(stat, '墟境系统');
  const current = ensureRuntime(refreshedRoot);
  const previousActive = previousState && isCompleteActive(previousState);
  const authorizedReturn = !!previousActive && returnAuthorized;
  if (previousActive && !authorizedReturn) {
    for (const key of ACTIVE_CARRY_FIELDS) {
      const shouldCarry = key === '墟境流程状态'
        ? !ACTIVE_FLOWS.has(text(current[key]))
        : key === '墟境任务规则锁定'
          ? Number(current[key]) !== 1
          : isEmpty(current[key]);
      if (shouldCarry) {
        current[key] = structuredClone(previousState[key]);
        changed = true;
      }
    }
    const sameRun = text(current.墟境轮次) === text(previousState.墟境轮次);
    if (sameRun) {
      for (const key of SAME_RUN_LOCKED_FIELDS) {
        if (current[key] !== previousState[key]) {
          current[key] = structuredClone(previousState[key]);
          changed = true;
        }
      }
    }
  }


  if (previousActive && authorizedReturn) {
    archivePreviousRun(current, previousState);
    const world = ensureRecord(stat, '世界');
    const realityTime = text(previousState.本轮现实时间)
      || text(previousState.墟境进入前时间);
    const realityLocation = text(previousState.本轮现实地点)
      || text(previousState.墟境进入前地点);
    if (realityTime && world.时间 !== realityTime) {
      world.时间 = realityTime;
      changed = true;
    }
    if (realityLocation && world.地点 !== realityLocation) {
      world.地点 = realityLocation;
      changed = true;
    }
    clearActiveRun(current);
    changed = syncSnapshot(refreshedRoot, current, false) || changed || true;
    return changed;
  }

  if (isCompleteActive(current)) {
    const world = ensureRecord(stat, '世界');
    if (world.时间 !== current.墟境当前时间) {
      world.时间 = current.墟境当前时间;
      changed = true;
    }
    if (world.地点 !== current.墟境当前地点) {
      world.地点 = current.墟境当前地点;
      changed = true;
    }
    if (current.本轮墟境离开时间 !== current.墟境当前时间) {
      current.本轮墟境离开时间 = current.墟境当前时间;
      changed = true;
    }
    if (current.本轮墟境离开地点 !== current.墟境当前地点) {
      current.本轮墟境离开地点 = current.墟境当前地点;
      changed = true;
    }
    changed = syncSnapshot(refreshedRoot, current, true) || changed;
    return changed;
  }

  return changed;
}

export function carryPlayerFloor(
  variables: Variables,
  previousVariablesValue: Variables,
): boolean {
  const previousStat = readRecord(previousVariablesValue.stat_data);
  const previousRoot = readRecord(previousStat.墟境系统);
  if (!Object.keys(previousRoot).length) return false;
  const stat = ensureRecord(variables, 'stat_data');
  stat.墟境系统 = structuredClone(previousRoot);
  const previousState = readRecord(previousRoot.运行状态);
  if (isCompleteActive(previousState)) {
    const previousWorld = readRecord(previousStat.世界);
    if (Object.keys(previousWorld).length) {
      stat.世界 = structuredClone(previousWorld);
    }
  }
  return true;
}

export function extractRuinPatchOperations(textValue: string): PatchOperation[] {
  const arrays = collectJsonArrays(textValue);
  const operations: PatchOperation[] = [];
  for (const source of arrays) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (!Array.isArray(parsed)) continue;
      for (const value of parsed) {
        if (!isRecord(value)) continue;
        const op = text(value.op);
        const path = normalizePatchPath(text(value.path));
        if (
          !['replace', 'add', 'insert'].includes(op)
          || !isAllowedPatchPath(path)
        ) continue;
        operations.push({ op, path, value: value.value });
      }
    } catch {
      // Narrative brackets are intentionally ignored.
    }
  }
  return operations;
}

export function strengthenEntryCommands(
  commands: Array<Record<string, unknown>>,
  assistantText: string,
): boolean {
  const operations = extractRuinPatchOperations(assistantText);
  const contract = contractFromOperations(operations);
  if (!contract || !isCompleteActive(contract)) return false;
  const entryOperations = operations.filter(operation =>
    operation.path.startsWith('/墟境系统/运行状态/')
    || operation.path === '/世界/时间'
    || operation.path === '/世界/地点'
  );
  if (!entryOperations.length) return false;

  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (commandTouchesEntry(commands[index])) commands.splice(index, 1);
  }
  commands.push({
    type: 'insert',
    args: ['墟境系统', "'运行状态'", '{}'],
    reason: 'eyon_time_kernel_runtime_init',
  });
  for (const operation of entryOperations) {
    const commandPath = pointerToCommandPath(operation.path);
    if (commandPath.startsWith('墟境系统.运行状态.')) {
      const key = commandPath.slice('墟境系统.运行状态.'.length);
      commands.push({
        type: 'insert',
        args: ['墟境系统.运行状态', `'${key}'`, JSON.stringify(operation.value)],
        reason: 'eyon_time_kernel_field_init',
      });
    }
    commands.push({
      type: 'set',
      args: [commandPath, JSON.stringify(operation.value)],
      reason: 'eyon_time_kernel_entry_contract',
    });
  }
  return true;
}

function previousVariables(
  runtime: TavernRuntime,
  bindings: TavernDataBindings,
  messageId: number,
): Variables | null {
  if (!bindings.getMessageVariables) return null;
  const messages = runtime.getChatMessages(
    `0-${Math.max(-1, messageId - 1)}`,
    { include_swipes: false },
  );
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.is_hidden) continue;
    if (message.role === 'assistant') {
      return bindings.getMessageVariables(message.message_id);
    }
  }
  return null;
}

function runtimeState(variables: Variables | null): RuntimeState | null {
  if (!variables) return null;
  const stat = readRecord(variables.stat_data);
  const root = readRecord(stat.墟境系统);
  const state = readRecord(root.运行状态);
  return Object.keys(state).length ? state : null;
}

function ensureRuntime(root: Variables): RuntimeState {
  const state = ensureRecord(root, '运行状态');
  for (const [key, value] of Object.entries(DEFAULT_RUNTIME)) {
    if (!(key in state)) state[key] = structuredClone(value);
  }
  return state;
}

function isCompleteActive(state: RuntimeState): boolean {
  return ACTIVE_FLOWS.has(text(state.墟境流程状态))
    && Number(state.墟境任务规则锁定) === 1
    && !!text(state.墟境轮次)
    && !!text(state.本轮现实时间 ?? state.墟境进入前时间)
    && !!text(state.本轮现实地点 ?? state.墟境进入前地点)
    && !!text(state.墟境当前时间)
    && !!text(state.墟境当前地点)
    && !!text(state.本轮墟境进入时间)
    && !!text(state.本轮墟境进入地点);
}

function archivePreviousRun(current: RuntimeState, previous: RuntimeState): void {
  current.归档轮次 = text(current.归档轮次) || text(previous.墟境轮次);
  current.归档现实时间 = text(current.归档现实时间)
    || text(previous.本轮现实时间)
    || text(previous.墟境进入前时间);
  current.归档现实地点 = text(current.归档现实地点)
    || text(previous.本轮现实地点)
    || text(previous.墟境进入前地点);
  current.归档墟境进入时间 = text(current.归档墟境进入时间)
    || text(previous.本轮墟境进入时间);
  current.归档墟境进入地点 = text(current.归档墟境进入地点)
    || text(previous.本轮墟境进入地点);
  current.归档墟境离开时间 = text(current.归档墟境离开时间)
    || text(previous.本轮墟境离开时间)
    || text(previous.墟境当前时间);
  current.归档墟境离开地点 = text(current.归档墟境离开地点)
    || text(previous.本轮墟境离开地点)
    || text(previous.墟境当前地点);
  current.蝴蝶效应锚定计数 = Math.max(
    Number(current.蝴蝶效应锚定计数) || 0,
    Number(previous.蝴蝶效应锚定计数) || 0,
  );
}

function clearActiveRun(state: RuntimeState): void {
  Object.assign(state, {
    墟境流程状态: 'idle',
    墟境任务规则锁定: 0,
    墟境待遣返: 0,
    墟境待蝴蝶效应结算: 0,
    墟境轮次: '',
    墟境进入前时间: '',
    墟境进入前地点: '',
    本轮现实时间: '',
    本轮现实地点: '',
    墟境当前时间: '',
    墟境当前地点: '',
    本轮墟境进入时间: '',
    本轮墟境进入地点: '',
    本轮墟境离开时间: '',
    本轮墟境离开地点: '',
  });
}

function syncSnapshot(
  root: Variables,
  state: RuntimeState,
  active: boolean,
): boolean {
  const next = {
    flowState: active ? text(state.墟境流程状态) : 'idle',
    runAuthorized: active,
    runId: active ? text(state.墟境轮次) : '',
    archiveRunId: text(state.归档轮次),
    lastRealityTime: active
      ? text(state.本轮现实时间) || text(state.墟境进入前时间)
      : text(state.归档现实时间),
    lastRealityLocation: active
      ? text(state.本轮现实地点) || text(state.墟境进入前地点)
      : text(state.归档现实地点),
    lockedRealTime: active
      ? text(state.本轮现实时间) || text(state.墟境进入前时间)
      : '',
    lockedRealLocation: active
      ? text(state.本轮现实地点) || text(state.墟境进入前地点)
      : '',
    ruinTime: active ? text(state.墟境当前时间) : '',
    ruinLocation: active ? text(state.墟境当前地点) : '',
    entryRuinPending: false,
    entryRuinTime: active ? text(state.本轮墟境进入时间) : '',
    entryRuinLocation: active ? text(state.本轮墟境进入地点) : '',
    exitRuinTime: active ? text(state.本轮墟境离开时间) : '',
    exitRuinLocation: active ? text(state.本轮墟境离开地点) : '',
    archiveRealTime: text(state.归档现实时间),
    archiveRealLocation: text(state.归档现实地点),
    archiveEntryRuinTime: text(state.归档墟境进入时间),
    archiveEntryRuinLocation: text(state.归档墟境进入地点),
    archiveExitRuinTime: text(state.归档墟境离开时间),
    archiveExitRuinLocation: text(state.归档墟境离开地点),
  };
  const previous = readRecord(root.虚嗣指南快照);
  const changed = JSON.stringify(previous) !== JSON.stringify(next);
  root.虚嗣指南快照 = next;
  return changed;
}

function applyPatchOperations(
  stat: Variables,
  operations: PatchOperation[],
): boolean {
  let changed = false;
  for (const operation of operations) {
    const parts = pointerParts(operation.path);
    if (!parts.length) continue;
    let cursor = stat;
    for (const part of parts.slice(0, -1)) {
      cursor = ensureRecord(cursor, part);
    }
    const key = parts.at(-1)!;
    if (JSON.stringify(cursor[key]) !== JSON.stringify(operation.value)) {
      cursor[key] = structuredClone(operation.value);
      changed = true;
    }
  }
  return changed;
}

function contractFromOperations(operations: PatchOperation[]): RuntimeState | null {
  const variables: Variables = { stat_data: {} };
  applyPatchOperations(readRecord(variables.stat_data), operations);
  return runtimeState(variables);
}

function normalizePatchPath(path: string): string {
  const direct = path.match(/^\/墟境系统\/(?!运行状态\/|虚嗣指南快照\/)([^/]+)$/u);
  return direct
    ? `/墟境系统/运行状态/${direct[1]}`
    : path;
}

function isAllowedPatchPath(path: string): boolean {
  if (path === '/世界/时间' || path === '/世界/地点') return true;
  const match = path.match(/^\/墟境系统\/运行状态\/([^/]+)$/u);
  return !!match && RUNTIME_FIELDS.has(match[1]);
}

function collectJsonArrays(source: string): string[] {
  const output: string[] = [];
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '[') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '[') depth += 1;
      else if (character === ']') depth -= 1;
      if (depth === 0) {
        const candidate = source.slice(start, index + 1);
        if (/"op"\s*:/u.test(candidate) && /"path"\s*:/u.test(candidate)) {
          output.push(candidate);
        }
        start = index;
        break;
      }
    }
  }
  return output;
}

function pointerParts(pointer: string): string[] {
  return pointer
    .split('/')
    .slice(1)
    .map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerToCommandPath(pointer: string): string {
  return pointerParts(pointer).join('.');
}

function commandTouchesEntry(command: Record<string, unknown>): boolean {
  const args = Array.isArray(command.args) ? command.args : [];
  const first = text(args[0]).replace(/^['"]|['"]$/g, '');
  const second = text(args[1]).replace(/^['"]|['"]$/g, '');
  const path = first === '墟境系统.运行状态'
    ? `${first}.${second}`
    : first;
  return path.startsWith('墟境系统.运行状态.')
    || path === '世界.时间'
    || path === '世界.地点';
}

function ensureRecord(parent: Variables, key: string): Variables {
  if (!isRecord(parent[key])) parent[key] = {};
  return parent[key] as Variables;
}

function readRecord(value: unknown): Variables {
  return isRecord(value) ? value : {};
}

function asRecord(value: unknown): Variables {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Variables {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}
