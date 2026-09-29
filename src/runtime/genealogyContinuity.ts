import type { BiographyRecord } from '../storage/biographies.ts';
import type { CanonBranch } from '../retrieval/contracts.ts';
import { continuityAnchorsFromCommittedRecords } from '../core/continuityAnchors.ts';
import { assessArtifactCanonBinding } from '../core/artifactCanonAssessment.ts';
import { currentArtifactCanonAssessmentTarget } from '../core/artifactCanonConsumption.ts';

export interface GenealogyHistoryReference {
  biographyId: string;
  stageId: string;
  participants: Array<{ entityId?: string; name: string }>;
  claim: string;
}

/** Resolve links from committed same-version producers, never model-supplied IDs. */
export function currentGenealogyHistoryReferences(records: readonly BiographyRecord[], branch: CanonBranch): GenealogyHistoryReference[] {
  records = records.filter(record => record.namespace.characterKey === branch.characterKey && record.namespace.chatId === branch.chatId);
  const bindings = records.flatMap(record => record.canonBindings ?? []);
  const target = currentArtifactCanonAssessmentTarget({ bindings, branch });
  const anchors = continuityAnchorsFromCommittedRecords(records, branch.branchId, branch.headRevision);
  // Final prose is the committed work; a planning-slot claim must not shadow it.
  anchors.sort((a, b) => Number(b.claimSource === 'final-prose') - Number(a.claimSource === 'final-prose'));
  return anchors.flatMap(anchor => {
    const binding = bindings.find(item => item.bindingId === anchor.producer.bindingId && item.artifactId === anchor.producer.artifactId && item.unitId === anchor.producer.unitId);
    if (!binding) return [];
    try {
      if (assessArtifactCanonBinding({ binding, view: target, branch }).status !== 'current') return [];
      return [{ biographyId: anchor.producer.artifactId, stageId: anchor.producer.unitId, participants: anchor.participants, claim: anchor.claim }];
    } catch { return []; }
  });
}

export function historyReferencesForPerson(references: readonly GenealogyHistoryReference[], name: string, entityId?: string): GenealogyHistoryReference[] {
  return references.filter(reference => reference.participants.some(person =>
    person.entityId && entityId ? person.entityId === entityId : person.name.trim() === name.trim()))
    .filter((reference, index, all) => all.findIndex(other => other.biographyId === reference.biographyId && other.stageId === reference.stageId) === index).slice(0, 4);
}
