import sharedContext from '../../rules/01_命定系统-伊雍-脚本上下文.txt?raw';
import retrievalContract from '../../rules/03_资料检索与上下文装配契约.txt?raw';
import validationContract from '../../rules/05_生成结果校验与失败恢复契约.txt?raw';
import ruinGenerationContract from '../../rules/11_墟境历史期生成规则-API.txt?raw';
import biographyGenerationContract from '../../rules/13_寻根溯源生成规则-API.txt?raw';
import type { BiographyRuleSet } from '../prompts/biography.ts';
import type { RuinRuleSet } from '../prompts/ruin.ts';

export const embeddedBiographyRules: BiographyRuleSet = {
  sharedContext,
  retrievalContract,
  validationContract,
  generationContract: biographyGenerationContract,
};

export const embeddedRuinRules: RuinRuleSet = {
  sharedContext,
  retrievalContract,
  validationContract,
  generationContract: ruinGenerationContract,
};
