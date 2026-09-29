import diceRules from '../../rules/08_伊雍骰子判定表-脚本数据.txt?raw';
import {
  createBiographyStagePlanFromRules,
  type BiographyStagePlan,
} from './biographyDiceCore.ts';

export function createBiographyStagePlan(): BiographyStagePlan {
  return createBiographyStagePlanFromRules(diceRules);
}
