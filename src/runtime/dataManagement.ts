import { namespaceKey, type WorkbenchNamespace } from '../core/namespace.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import type {
  ButterflyRecord,
  CanonMemoryTombstone,
  PendingSettlement,
} from '../storage/butterflies.ts';
import type { GenealogyRecord } from '../storage/genealogies.ts';
import type { RuinSelectedCharacter } from '../storage/ruinReferences.ts';
import type { RuinCandidateRecord } from '../storage/ruins.ts';
import type { WorkbenchSettings } from './workbenchSettings.ts';

export interface WorkbenchDataCollection {
  biographies: BiographyRecord[];
  genealogies: GenealogyRecord[];
  ruins: RuinCandidateRecord[];
  butterflies: ButterflyRecord[];
  pendingButterflies: PendingSettlement[];
  canonMemoryTombstones: CanonMemoryTombstone[];
  ruinReferences: RuinSelectedCharacter[];
}

export interface WorkbenchDataInspection {
  namespace: WorkbenchNamespace;
  checkedAt: string;
  counts: {
    biographies: number;
    genealogies: number;
    ruins: number;
    butterflies: number;
    pendingButterflies: number;
    canonMemoryTombstones: number;
    ruinReferences: number;
  };
  issues: string[];
  healthy: boolean;
}

export interface WorkbenchDataBackup {
  format: 'eyon-history-workbench-backup';
  schemaVersion: 1;
  workbenchVersion: string;
  exportedAt: string;
  namespace: WorkbenchNamespace;
  settings: WorkbenchSettings;
  data: WorkbenchDataCollection;
}

export function inspectWorkbenchData(
  namespace: WorkbenchNamespace,
  data: WorkbenchDataCollection,
): WorkbenchDataInspection {
  const issues: string[] = [];
  const expectedNamespace = namespaceKey(namespace);

  inspectNamespacedRecords('传记', data.biographies, expectedNamespace, issues);
  inspectNamespacedRecords('宗族谱系', data.genealogies, expectedNamespace, issues);
  inspectNamespacedRecords('候选墟境', data.ruins, expectedNamespace, issues);
  inspectNamespacedRecords('蝴蝶效应', data.butterflies, expectedNamespace, issues);
  inspectNamespacedRecords('正史记忆残片', data.canonMemoryTombstones, expectedNamespace, issues);
  inspectNamespacedRecords(
    '待结算蝴蝶效应',
    data.pendingButterflies,
    expectedNamespace,
    issues,
  );
  inspectUnique(
    '传记请求',
    data.biographies.map(record => record.requestId),
    issues,
  );
  inspectUnique(
    '谱系请求',
    data.genealogies.map(record => record.requestId),
    issues,
  );
  inspectUnique(
    '墟境请求',
    data.ruins.map(record => record.requestId),
    issues,
  );
  inspectUnique(
    '蝴蝶效应轮次',
    data.butterflies.map(record => record.runId),
    issues,
  );
  inspectUnique(
    '墟境参考人物',
    data.ruinReferences.map(record => record.mvuId),
    issues,
  );

  return {
    namespace: structuredClone(namespace),
    checkedAt: new Date().toISOString(),
    counts: {
      biographies: data.biographies.length,
      genealogies: data.genealogies.length,
      ruins: data.ruins.length,
      butterflies: data.butterflies.length,
      pendingButterflies: data.pendingButterflies.length,
      canonMemoryTombstones: data.canonMemoryTombstones.length,
      ruinReferences: data.ruinReferences.length,
    },
    issues,
    healthy: issues.length === 0,
  };
}

export function createWorkbenchBackup(
  version: string,
  namespace: WorkbenchNamespace,
  settings: WorkbenchSettings,
  data: WorkbenchDataCollection,
): WorkbenchDataBackup {
  return {
    format: 'eyon-history-workbench-backup',
    schemaVersion: 1,
    workbenchVersion: version,
    exportedAt: new Date().toISOString(),
    namespace: structuredClone(namespace),
    settings: redactApiKeys(settings),
    data: structuredClone(data),
  };
}

function redactApiKeys(settings: WorkbenchSettings): WorkbenchSettings {
  const safe = structuredClone(settings);
  for (const generation of Object.values(safe.generation)) {
    generation.key = '';
  }
  return safe;
}

function inspectNamespacedRecords(
  label: string,
  records: Array<{ namespace: WorkbenchNamespace }>,
  expectedNamespace: string,
  issues: string[],
): void {
  const leaked = records.filter(record =>
    namespaceKey(record.namespace) !== expectedNamespace).length;
  if (leaked > 0) issues.push(`${label}中发现${leaked}条其他聊天的数据`);
}

function inspectUnique(
  label: string,
  values: string[],
  issues: string[],
): void {
  const normalized = values.filter(Boolean);
  const duplicateCount = normalized.length - new Set(normalized).size;
  if (duplicateCount > 0) issues.push(`${label}中发现${duplicateCount}个重复标识`);
}
