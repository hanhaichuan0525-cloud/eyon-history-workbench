import {
  type EvidenceClaim,
  type EvidencePassage,
  type EvidencePassageBudget,
  type RetrievalPassageDecision,
  type SourceSnapshot,
} from './contracts.ts';
import { normalizeRetrievalText } from './index.ts';
import { stableSha256 } from './sourceSnapshot.ts';

interface PassageCandidate {
  snapshot: SourceSnapshot;
  sectionPath: string[];
  startOffset: number;
  endOffset: number;
  extractionMode: EvidencePassage['extractionMode'];
  matchedAnchors: string[];
  temporalScopes: string[];
  reasons: string[];
  score: number;
  mandatory: boolean;
  /** 0=核心角色权威段，1=用户查询锚，2=关系证据，3=可选来源兜底。 */
  priority: 0 | 1 | 2 | 3;
}

export interface EvidencePassageAssembly {
  passages: EvidencePassage[];
  selected: RetrievalPassageDecision[];
  rejected: RetrievalPassageDecision[];
  usedChars: number;
  /** R-04：预算不足被丢弃的 desired（P1/P2）覆盖锚，不抛错。 */
  omittedAnchors: string[];
}

export async function assembleEvidencePassages(input: {
  snapshots: SourceSnapshot[];
  queryAnchors: string[];
  fatalCoverageAnchors?: string[];
  requiredSourceAnchors?: Array<{ anchor: string; snapshotIds: string[] }>;
  claims: EvidenceClaim[];
  budget: EvidencePassageBudget;
}): Promise<EvidencePassageAssembly> {
  const anchors = independentAnchors(input.queryAnchors, input.snapshots);
  const fatalAnchors = new Set(
    (input.fatalCoverageAnchors ?? [])
      .map(normalizeRetrievalText)
      .filter(value => value.length >= 2),
  );
  const sectionsBySnapshot = new Map<string, PassageCandidate[]>();
  const candidates: PassageCandidate[] = [];
  for (const snapshot of input.snapshots) {
    const sections = splitIntoSections(snapshot, input.budget)
      .map(section => scoreCandidate(section, anchors, input.claims));
    sectionsBySnapshot.set(snapshot.snapshotId, sections);
    candidates.push(...sections);
  }

  const required = new Set<PassageCandidate>();
  // 上游已经筛过当前有效、与查询相关的来源；蝴蝶档案是已发生历史，
  // 时间表、行动记录与演变必须作为一个整体投递，不能只选得分最高的表格。
  for (const candidate of candidates) {
    if (candidate.snapshot.sourceType !== 'butterfly') continue;
    candidate.mandatory = true;
    candidate.priority = 0;
    candidate.reasons.push('butterfly-continuity-full');
    required.add(candidate);
  }
  for (const anchor of anchors) {
    const best = candidates
      .filter(candidate => candidate.matchedAnchors.includes(anchor))
      .sort(compareCandidate)[0];
    if (best) {
      best.priority = Math.min(best.priority, 1) as PassageCandidate['priority'];
      if (fatalAnchors.has(normalizeRetrievalText(anchor))) {
        best.mandatory = true;
        best.priority = 0;
      }
      required.add(best);
    }
  }
  for (const requirement of input.requiredSourceAnchors ?? []) {
    const normalizedAnchor = normalizeRetrievalText(requirement.anchor);
    const allowedSnapshotIds = new Set(requirement.snapshotIds);
    const best = candidates
      .filter(candidate => allowedSnapshotIds.has(candidate.snapshot.snapshotId))
      .filter(candidate => {
        const content = normalizeRetrievalText(candidate.snapshot.content.slice(
          candidate.startOffset,
          candidate.endOffset,
        ));
        const path = normalizeRetrievalText(candidate.sectionPath.join('\n'));
        const title = normalizeRetrievalText(candidate.snapshot.title);
        return content.includes(normalizedAnchor)
          || path.includes(normalizedAnchor)
          || title.includes(normalizedAnchor);
      })
      .sort(compareCandidate)[0];
    if (best) {
      best.matchedAnchors = unique([...best.matchedAnchors, requirement.anchor]);
      best.reasons = unique([...best.reasons, `cast-authority:${requirement.anchor}`]);
      best.score += 240;
      best.mandatory = true;
      best.priority = 0;
      required.add(best);
    }
  }
  for (const claim of input.claims) {
    for (const snapshotId of claim.sourceSnapshotIds) {
      const sections = sectionsBySnapshot.get(snapshotId) ?? [];
      const subject = normalizeRetrievalText(claim.subject);
      const object = normalizeRetrievalText(claim.object);
      const best = sections
        .filter(candidate => {
          const content = normalizeRetrievalText(candidate.snapshot.content.slice(
            candidate.startOffset,
            candidate.endOffset,
          ));
          return content.includes(subject) || content.includes(object);
        })
        .sort(compareCandidate)[0];
      if (best) {
        best.reasons = unique([...best.reasons, `claim:${claim.predicate}`]);
        best.score += 80;
        best.priority = Math.min(best.priority, 2) as PassageCandidate['priority'];
        required.add(best);
      }
    }
  }

  for (const snapshot of input.snapshots) {
    if ([...required].some(candidate => candidate.snapshot.snapshotId === snapshot.snapshotId)) {
      continue;
    }
    const sections = sectionsBySnapshot.get(snapshot.snapshotId) ?? [];
    const fallback = sections.sort(compareCandidate)[0];
    if (fallback) {
      fallback.reasons = unique([...fallback.reasons, 'selected-source-fallback']);
      fallback.priority = 3;
      required.add(fallback);
    }
  }

  const merged = mergeCandidates([...required]);
  const accepted: PassageCandidate[] = [];
  const rejected: RetrievalPassageDecision[] = [];
  let usedChars = 0;
  let excerptBudgetChars = 0;
  for (const candidate of merged.sort(compareCandidate)) {
    const charCount = candidate.endOffset - candidate.startOffset;
    const completeHistory = candidate.snapshot.sourceType === 'butterfly';
    if (
      !completeHistory
      && !candidate.mandatory
      && accepted.length > 0
      && excerptBudgetChars + charCount > input.budget.softLimitChars
    ) {
      rejected.push(toDecision(candidate, 'soft-passage-budget-exhausted'));
      continue;
    }
    if (!completeHistory && excerptBudgetChars + charCount > input.budget.hardLimitChars) {
      rejected.push(toDecision(candidate, 'hard-passage-budget-exhausted'));
      continue;
    }
    accepted.push(candidate);
    usedChars += charCount;
    if (!completeHistory) excerptBudgetChars += charCount;
  }

  const coveredAnchors = new Set(accepted.flatMap(candidate => candidate.matchedAnchors));
  const uncovered = anchors.filter(anchor =>
    candidates.some(candidate => candidate.matchedAnchors.includes(anchor))
    && !coveredAnchors.has(anchor));
  // R-04 失败分级：fatal 覆盖锚（required/group-required 的 P0）未保留 → 硬失败；
  // desired 覆盖锚（P1/P2 普通查询锚与 recommended）预算不足 → 进 omittedAnchors，不抛错。
  const fatalUncovered = uncovered.filter(anchor =>
    fatalAnchors.has(normalizeRetrievalText(anchor)));
  if (fatalUncovered.length > 0) {
    throw new Error(`Evidence passage budget cannot preserve required anchors: ${fatalUncovered.join(',')}`);
  }
  const omittedAnchors = uncovered.map(normalizeRetrievalText);

  const snapshotOrder = new Map(input.snapshots.map((snapshot, index) => [snapshot.snapshotId, index]));
  const passages = await Promise.all(accepted
    .sort((left, right) =>
      (snapshotOrder.get(left.snapshot.snapshotId) ?? 0)
      - (snapshotOrder.get(right.snapshot.snapshotId) ?? 0)
      || left.startOffset - right.startOffset)
    .map(toPassage));
  return {
    passages,
    selected: passages.map((passage, index) => ({
      snapshotId: passage.snapshotId,
      startOffset: passage.startOffset,
      endOffset: passage.endOffset,
      passageId: passage.passageId,
      contentHash: passage.contentHash,
      sectionPath: passage.sectionPath,
      extractionMode: passage.extractionMode,
      matchedAnchors: passage.matchedAnchors,
      temporalScopes: passage.temporalScopes,
      reason: passage.selectionReasons.join(';'),
      charCount: passage.charCount,
      score: accepted[index]?.score,
    })),
    rejected,
    usedChars,
    omittedAnchors,
  };
}

export function attachClaimPassages(
  claims: EvidenceClaim[],
  passages: EvidencePassage[],
): EvidenceClaim[] {
  return claims.map(claim => {
    const sourceIds = new Set(claim.sourceSnapshotIds);
    const subject = normalizeRetrievalText(claim.subject);
    const object = normalizeRetrievalText(claim.object);
    const sameSource = passages.filter(passage => sourceIds.has(passage.snapshotId));
    const direct = sameSource.filter(passage => {
      const content = normalizeRetrievalText(passage.content);
      return content.includes(subject) || content.includes(object);
    });
    return {
      ...claim,
      sourcePassageIds: (direct.length > 0 ? direct : sameSource)
        .map(passage => passage.passageId),
    };
  });
}

function splitIntoSections(
  snapshot: SourceSnapshot,
  budget: EvidencePassageBudget,
): PassageCandidate[] {
  const content = snapshot.content;
  const headings: string[] = [];
  const rawSections: PassageCandidate[] = [];
  let sectionStart: number | null = null;
  let sectionEnd = 0;
  let sectionPath: string[] = [];
  let hasHeadings = false;
  const flush = () => {
    if (sectionStart === null) return;
    const [startOffset, endOffset] = trimOffsets(content, sectionStart, sectionEnd);
    if (endOffset > startOffset) {
      rawSections.push({
        snapshot,
        sectionPath,
        startOffset,
        endOffset,
        extractionMode: 'section',
        matchedAnchors: [],
        temporalScopes: temporalScopes(content.slice(startOffset, endOffset)),
        reasons: [],
        score: 0,
        mandatory: false,
        priority: 3,
      });
    }
    sectionStart = null;
  };

  for (const match of content.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)) {
    const rawLine = match[0];
    if (!rawLine) break;
    const line = rawLine.replace(/(?:\r\n|\n|\r)$/u, '');
    const start = match.index;
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/u);
    if (heading) {
      flush();
      hasHeadings = true;
      const level = heading[1].length;
      headings.splice(level - 1);
      headings[level - 1] = heading[2].trim();
      sectionPath = headings.filter(Boolean);
      continue;
    }
    if (!line.trim() || /^\s*---+\s*$/u.test(line)) {
      flush();
      continue;
    }
    if (/^\s*<\/?[^>]+>\s*$/u.test(line)) continue;
    if (sectionStart === null) {
      sectionStart = start;
      sectionPath = headings.filter(Boolean);
    }
    sectionEnd = start + line.length;
  }
  flush();

  if (rawSections.length === 0 && content.trim()) {
    const [startOffset, endOffset] = trimOffsets(content, 0, content.length);
    rawSections.push({
      snapshot,
      sectionPath: [],
      startOffset,
      endOffset,
      extractionMode: 'full',
      matchedAnchors: [],
      temporalScopes: temporalScopes(content.slice(startOffset, endOffset)),
      reasons: [],
      score: 0,
      mandatory: false,
      priority: 3,
    });
  }

  if (snapshot.sourceType === 'butterfly'
    || (!hasHeadings && content.trim().length <= budget.fullSourceLimitChars)) {
    const [startOffset, endOffset] = trimOffsets(content, 0, content.length);
    return [{
      snapshot,
      sectionPath: [],
      startOffset,
      endOffset,
      extractionMode: 'full',
      matchedAnchors: [],
      temporalScopes: temporalScopes(content.slice(startOffset, endOffset)),
      reasons: [],
      score: 0,
      mandatory: false,
      priority: 3,
    }];
  }

  const sections = rawSections.flatMap(section =>
    splitOversizedSection(section, budget.maxWindowChars));
  if (sections.length === 1 && content.length <= budget.maxWindowChars) {
    sections[0].extractionMode = 'full';
  }
  return sections;
}

function splitOversizedSection(
  section: PassageCandidate,
  maxWindowChars: number,
): PassageCandidate[] {
  const length = section.endOffset - section.startOffset;
  if (length <= maxWindowChars) return [section];
  const output: PassageCandidate[] = [];
  const overlap = Math.min(160, Math.floor(maxWindowChars / 8));
  for (let start = section.startOffset; start < section.endOffset;) {
    const end = Math.min(section.endOffset, start + maxWindowChars);
    output.push({ ...section, startOffset: start, endOffset: end, extractionMode: 'window' });
    if (end === section.endOffset) break;
    start = end - overlap;
  }
  return output;
}

function scoreCandidate(
  candidate: PassageCandidate,
  anchors: string[],
  claims: EvidenceClaim[],
): PassageCandidate {
  const content = candidate.snapshot.content.slice(candidate.startOffset, candidate.endOffset);
  const normalizedContent = normalizeRetrievalText(content);
  const normalizedPath = normalizeRetrievalText(candidate.sectionPath.join('\n'));
  const matchedAnchors = anchors.filter(anchor =>
    normalizedContent.includes(anchor) || normalizedPath.includes(anchor));
  const claimMatches = claims.filter(claim =>
    claim.sourceSnapshotIds.includes(candidate.snapshot.snapshotId)
    && (
      normalizedContent.includes(normalizeRetrievalText(claim.subject))
      || normalizedContent.includes(normalizeRetrievalText(claim.object))
    ));
  const score = matchedAnchors.reduce((total, anchor) =>
    total + Math.min(anchor.length, 16) * 12 + (/纪元/u.test(anchor) ? 140 : 0), 0)
    + claimMatches.length * 80
    + (candidate.sectionPath.some(path => matchedAnchors.some(anchor =>
      normalizeRetrievalText(path).includes(anchor))) ? 70 : 0)
    - Math.min(80, Math.floor(content.length / 200));
  return {
    ...candidate,
    matchedAnchors,
    temporalScopes: temporalScopes(content),
    reasons: [
      ...matchedAnchors.map(anchor => `query-anchor:${anchor}`),
      ...claimMatches.map(claim => `claim:${claim.predicate}`),
    ],
    score,
  };
}

function mergeCandidates(candidates: PassageCandidate[]): PassageCandidate[] {
  const sorted = [...candidates].sort((left, right) =>
    left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId)
    || left.startOffset - right.startOffset);
  const output: PassageCandidate[] = [];
  for (const candidate of sorted) {
    const previous = output.at(-1);
    if (
      previous
      && previous.snapshot.snapshotId === candidate.snapshot.snapshotId
      && candidate.startOffset <= previous.endOffset
    ) {
      previous.endOffset = Math.max(previous.endOffset, candidate.endOffset);
      previous.matchedAnchors = unique([...previous.matchedAnchors, ...candidate.matchedAnchors]);
      previous.temporalScopes = unique([...previous.temporalScopes, ...candidate.temporalScopes]);
      previous.reasons = unique([...previous.reasons, ...candidate.reasons]);
      previous.score = Math.max(previous.score, candidate.score);
      previous.mandatory = previous.mandatory || candidate.mandatory;
      previous.priority = Math.min(previous.priority, candidate.priority) as PassageCandidate['priority'];
      previous.extractionMode = previous.startOffset === 0
        && previous.endOffset === previous.snapshot.content.length
        ? 'full'
        : previous.extractionMode === 'window' || candidate.extractionMode === 'window'
        ? 'window'
        : 'section';
      continue;
    }
    output.push({ ...candidate });
  }
  return output;
}

async function toPassage(candidate: PassageCandidate): Promise<EvidencePassage> {
  const content = candidate.snapshot.content.slice(candidate.startOffset, candidate.endOffset);
  const contentHash = await stableSha256({ content });
  return {
    passageId: `${candidate.snapshot.snapshotId}#chars:${candidate.startOffset}-${candidate.endOffset}@sha256:${contentHash}`,
    snapshotId: candidate.snapshot.snapshotId,
    sourceId: candidate.snapshot.logicalId,
    sourceType: candidate.snapshot.sourceType,
    title: candidate.snapshot.title,
    sectionPath: [...candidate.sectionPath],
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    extractionMode: candidate.extractionMode,
    content,
    contentHash,
    charCount: content.length,
    matchedAnchors: unique(candidate.matchedAnchors),
    temporalScopes: unique(candidate.temporalScopes),
    selectionReasons: unique(candidate.reasons),
  };
}

function toDecision(candidate: PassageCandidate, reason: string): RetrievalPassageDecision {
  return {
    snapshotId: candidate.snapshot.snapshotId,
    startOffset: candidate.startOffset,
    endOffset: candidate.endOffset,
    reason,
    charCount: candidate.endOffset - candidate.startOffset,
    score: candidate.score,
  };
}

function compareCandidate(left: PassageCandidate, right: PassageCandidate): number {
  return Number(right.mandatory) - Number(left.mandatory)
    || left.priority - right.priority
    || right.score - left.score
    || (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset)
    || left.snapshot.snapshotId.localeCompare(right.snapshot.snapshotId)
    || left.startOffset - right.startOffset;
}

function independentAnchors(values: string[], snapshots: SourceSnapshot[]): string[] {
  const normalized = unique(values
    .map(normalizeRetrievalText)
    .filter(value => value.length >= 2 && value.length <= 32));
  const corpus = normalizeRetrievalText(snapshots
    .map(snapshot => `${snapshot.title}\n${snapshot.content}`)
    .join('\n'));
  return normalized
    .filter(value => corpus.includes(value))
    .filter(value => !normalized.some(candidate =>
      candidate !== value
      && candidate.includes(value)
      && corpus.includes(candidate)));
}

function temporalScopes(content: string): string[] {
  return unique(content.match(/[\p{Script=Han}]{2,8}纪元(?:\d{1,6}年)?|\d{1,6}年/gu) ?? []);
}

function trimOffsets(content: string, start: number, end: number): [number, number] {
  while (start < end && /\s/u.test(content[start])) start += 1;
  while (end > start && /\s/u.test(content[end - 1])) end -= 1;
  return [start, end];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
