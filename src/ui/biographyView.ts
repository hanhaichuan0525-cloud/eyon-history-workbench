import type { Biography } from '../schemas/biography.ts';
import type { BiographyRecord } from '../storage/biographies.ts';
import { resolveBiographyDisplayIdentity } from '../renderers/biographyIdentity.ts';

export interface BiographyShelfItem {
  record: BiographyRecord;
  title: string;
  subtitle: string;
  metadata: string[];
  accent: string;
}

const ACCENTS = ['#6d5876', '#357b7c', '#8b654b', '#68745a', '#a28155'];

export function biographyDisplayTitle(biography: Biography): string {
  return resolveBiographyDisplayIdentity(biography).title;
}

export function toBiographyShelfItem(
  record: BiographyRecord,
  index = 0,
): BiographyShelfItem {
  const biography = record.biography;
  const identity = resolveBiographyDisplayIdentity(biography);
  return {
    record,
    title: identity.title,
    subtitle: identity.subtitle,
    metadata: [
      biography.span.label ?? '',
      `${biography.stages.length}个历史时期`,
    ],
    accent: ACCENTS[index % ACCENTS.length],
  };
}

export function visibleBiographyItems(
  records: BiographyRecord[],
  query = '',
): BiographyShelfItem[] {
  const normalizedQuery = normalize(query);
  return [...records]
    .filter(record => record.status === 'validated' || record.status === 'committed')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((record, index) => toBiographyShelfItem(record, index))
    .filter(item => {
      if (!normalizedQuery) return true;
      const biography = item.record.biography;
      const playerText = [
        biography.playerDirective?.primaryDirection ?? '',
        biography.playerDirective?.raw ?? '',
      ].join(' ');
      return normalize([
        item.title,
        item.subtitle,
        biography.target.name,
        ...biography.target.aliases,
        biography.span.label ?? '',
        biography.summary,
        playerText, // 玩家输入方向仍是合法检索键（显示已改为 summary，检索保留）
        ...biography.indexes.people,
        ...biography.indexes.factions,
        ...biography.indexes.locations,
        ...biography.indexes.themes,
      ].join(' ')).includes(normalizedQuery);
    });
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}
