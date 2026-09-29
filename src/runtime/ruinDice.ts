import diceRules from '../../rules/08_伊雍骰子判定表-脚本数据.txt?raw';
import type { RuinGenerationInput } from '../schemas/ruin.ts';
import {
  createRuinMaterialsFromRules,
  waveForCandidateCount,
} from './ruinDiceCore.ts';

export { waveForCandidateCount };

export function createRuinMaterials(
  candidateCount: 3 | 4 | 5,
  random: () => number = Math.random,
): RuinGenerationInput['materials'] {
  return createRuinMaterialsFromRules(diceRules, candidateCount, random);
}
