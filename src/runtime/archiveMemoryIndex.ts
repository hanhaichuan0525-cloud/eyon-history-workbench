/** Disposable keyword index. Saved prose is the source of truth; no model or persistence writes. */
export interface ArchiveMemoryUnit {
  key: string;
  title: string;
  content: string;
  keywords: string[];
}

const GENERIC = new Set([
  '历史', '传记', '人物', '世界', '事件', '故事', '档案', '记录', '资料', '正文',
  '起源', '现状', '过去', '现在', '未来', '当时', '后来', '已经', '没有', '可以',
  '一个', '这个', '那个', '他们', '她们', '自己', '什么', '怎么', '为什么',
  '关于', '相关', '回忆', '告诉', '看看', '探讨', '发生', '继续', '主人', '伊雍',
]);
const WEAK_ONLY = new Set(['死亡', '契约', '姐姐', '父亲', '母亲', '城市', '帝国', '王国']);
const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter('zh-CN', { granularity: 'word' }) : null;

export function normalizeMemoryText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, '');
}

function usable(word: string): boolean {
  return word.length >= 2 && !GENERIC.has(word) && !/^\d+$/u.test(word);
}

function words(value: string): Set<string> {
  // Segment whole text for indexing only; original passages are never sliced.
  const tokens = segmenter
    ? [...segmenter.segment(value)]
      .filter(part => part.isWordLike).map(part => part.segment)
    : value.match(/[\p{Script=Han}]{2,}|[a-z0-9_-]{3,}/giu) ?? [];
  return new Set(tokens.map(normalizeMemoryText).filter(usable));
}

export class ArchiveMemoryIndex {
  private scope = '';
  private query = { raw: '', normalized: '', words: new Set<string>() };
  private readonly units = new Map<string, {
    source: ArchiveMemoryUnit;
    keywordStamp: string;
    strong: string[];
    weak: Set<string>;
  }>();

  reset(scope = ''): void {
    this.scope = scope;
    this.units.clear();
  }

  sync(scope: string, sources: ArchiveMemoryUnit[]): void {
    if (scope !== this.scope) this.reset(scope);
    const live = new Set(sources.map(source => source.key));
    for (const key of this.units.keys()) if (!live.has(key)) this.units.delete(key);
    for (const source of sources) {
      const keywordStamp = JSON.stringify([source.title, ...source.keywords]);
      const cached = this.units.get(source.key);
      if (cached?.source.content === source.content && cached.keywordStamp === keywordStamp) continue;
      this.units.set(source.key, {
        source, keywordStamp,
        strong: [...new Set([source.title, ...source.keywords,
          ...[...source.content.matchAll(/《([^《》\n]+)》/gu)].map(match => match[1]!),
        ].map(normalizeMemoryText).filter(word => (usable(word) || word === '伊雍') && !WEAK_ONLY.has(word)))],
        weak: words(source.content),
      });
    }
  }

  score(key: string, query: string, focus = ''): { score: number; hits: string[] } {
    const unit = this.units.get(key);
    if (!unit) return { score: 0, hits: [] };
    if (query !== this.query.raw) this.query = { raw: query, normalized: normalizeMemoryText(query), words: words(query) };
    const text = this.query.normalized;
    const current = normalizeMemoryText(focus);
    const strongHits = unit.strong.filter(word => text.includes(word));
    const weakHits = [...this.query.words].filter(word => unit.weak.has(word));
    // A named subject/title/object is sufficient. Ordinary prose needs two distinct terms.
    if (strongHits.length === 0 && weakHits.length < 2) return { score: 0, hits: [] };
    const hits = [...new Set([...strongHits, ...weakHits])];
    return {
      score: strongHits.length * 4 + weakHits.length
        + hits.filter(word => current.includes(word)).length * 8,
      hits,
    };
  }
}
