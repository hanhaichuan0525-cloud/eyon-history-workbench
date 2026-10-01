import {
  ruinCharacterReferenceIdentity,
  type RuinSelectedCharacter,
} from '../storage/ruinReferences.ts';

/** 只响应明确加入的新引用；重复广播、已有关闭项与整个宗族自动关联互不影响。 */
export function selectAddedRuinReferences(
  previous: RuinSelectedCharacter[],
  next: RuinSelectedCharacter[],
  selected: Set<string>,
): void {
  const previousIds = new Set(previous.map(ruinCharacterReferenceIdentity));
  const nextIds = new Set(next.map(ruinCharacterReferenceIdentity));
  for (const id of selected) if (!nextIds.has(id)) selected.delete(id);
  for (const id of nextIds) if (!previousIds.has(id)) selected.add(id);
}
