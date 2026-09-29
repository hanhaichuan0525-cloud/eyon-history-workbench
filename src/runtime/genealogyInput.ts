import type { WorkbenchCommand } from '../core/commands.ts';
import type {
  GenealogyGenerationInput,
} from '../schemas/genealogy.ts';
import type { RuntimeContextSourceProvider } from './contracts.ts';

export interface GenealogyDepthProvider {
  getGenealogyDepth(): {
    ancestors: number;
    descendants: number;
    maxPerGeneration: number;
  };
}

export class TavernGenealogyInputProvider {
  private readonly sources: RuntimeContextSourceProvider;
  private readonly depthProvider: GenealogyDepthProvider;

  constructor(
    sources: RuntimeContextSourceProvider,
    depthProvider: GenealogyDepthProvider,
  ) {
    this.sources = sources;
    this.depthProvider = depthProvider;
  }

  async getInput(command: WorkbenchCommand): Promise<GenealogyGenerationInput> {
    const requestedName = extractGenealogyFocusName(command.raw);
    if (!requestedName) {
      throw new Error('请在宗族谱系命令中写明MVU人物名称');
    }
    const characters = await this.sources.getCharacterSources();
    const focus = characters.find(character =>
      normalize(character.title) === normalize(requestedName)
    );
    if (!focus) {
      throw new Error(`MVU关系列表中没有找到人物：${requestedName}`);
    }
    return {
      focusCharacter: {
        mvuId: focus.sourceId.replace(/^mvu-character:/u, ''),
        name: focus.title,
        aliases: [],
      },
      depth: this.depthProvider.getGenealogyDepth(),
    };
  }
}

export function extractGenealogyFocusName(raw: string): string {
  const normalized = raw.normalize('NFKC').trim();
  const prefixed = /^(?:请)?宗族谱系(?:[\s，,：:]+)(.{1,80})$/u.exec(normalized);
  if (prefixed) return clean(prefixed[1]);
  const directed = /^(?:请)?(?:对|为)(.{1,80}?)(?:生成|整理|建立)(?:一份)?宗族谱系(?:[\s，,：:].*)?$/u.exec(normalized);
  return directed ? clean(directed[1]) : '';
}

function clean(value: string): string {
  return value.replace(/[。.!！]+$/gu, '').trim();
}

function normalize(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').trim();
}
