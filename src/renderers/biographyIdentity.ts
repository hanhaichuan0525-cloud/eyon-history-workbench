import type { Biography } from '../schemas/biography.ts';

export interface BiographyDisplayIdentity {
  /** 含书名号的完整展示标题。 */
  title: string;
  /** 不含书名号，供 RootTrace 语义校验使用。 */
  titleText: string;
  subtitle: string;
}

type BiographyIdentitySource = {
  target: { name: string };
  span: { label?: string };
  summary: string;
  playerDirective?: Partial<Biography['playerDirective']>;
  presentation?: Biography['presentation'];
};

const TITLE_BODY_MAX = 30;
const SUBTITLE_MAX = 36;
const SUBTITLE_MIN = 12;

/**
 * 传记正文卡与工作台共用的展示身份解析器。
 * presentation 只是可选的展示建议：任何缺失、漂移或不合格值都会静默回退，
 * 绝不参与传记内容与正史校验，也不会使生成失败。
 */
export function resolveBiographyDisplayIdentity(
  biography: BiographyIdentitySource,
): BiographyDisplayIdentity {
  const targetName = compactInlineText(biography.target.name) || '未命名对象';
  const rawDirective = compactInlineText(biography.playerDirective?.raw ?? '');
  const primaryDirection = compactInlineText(
    biography.playerDirective?.primaryDirection ?? '',
  );
  const forbiddenEchoes = [rawDirective, primaryDirection].filter(Boolean);

  const proposedTitle = sanitizeTitle(
    biography.presentation?.title,
    targetName,
    forbiddenEchoes,
  );
  const titleText = proposedTitle || fallbackTitleText(
    targetName,
    biography.span.label ?? '',
  );

  const proposedSubtitle = sanitizeSubtitle(
    biography.presentation?.subtitle,
    forbiddenEchoes,
  );
  const subtitle = proposedSubtitle || compactSubtitle(biography.summary);

  return {
    title: `《${titleText}》`,
    titleText,
    subtitle,
  };
}

function sanitizeTitle(
  value: string | undefined,
  targetName: string,
  forbiddenEchoes: string[],
): string {
  let title = compactInlineText(value ?? '')
    .replace(/^《|》$/gu, '')
    .trim();
  if (!title || looksLikeInstruction(title) || echoesDirective(title, forbiddenEchoes)) {
    return '';
  }
  // 展示标题必须能独立识别对象；模型只给焦点词时，本地补对象名，不要求重试。
  if (!title.includes(targetName)) title = `${targetName}·${title}`;
  // 「对象名」或「对象名传」没有区分度，交给带跨度的确定性回退。
  if (title === targetName || title === `${targetName}传`) return '';
  return truncateAtBoundary(title, TITLE_BODY_MAX, 6);
}

function sanitizeSubtitle(
  value: string | undefined,
  forbiddenEchoes: string[],
): string {
  const subtitle = compactInlineText(value ?? '');
  if (!subtitle || looksLikeInstruction(subtitle) || echoesDirective(subtitle, forbiddenEchoes)) {
    return '';
  }
  const compact = truncateAtBoundary(subtitle, SUBTITLE_MAX, SUBTITLE_MIN);
  return Array.from(compact).length >= SUBTITLE_MIN ? compact : '';
}

function fallbackTitleText(targetName: string, spanLabel: string): string {
  const scope = compactInlineText(spanLabel)
    .replace(/\s*(?:至|到)\s*/gu, '—')
    .replace(/\s*[–—-]\s*/gu, '—');
  if (!scope) return `${targetName}传`;
  return truncateAtBoundary(`${targetName}传·${scope}`, TITLE_BODY_MAX, targetName.length + 2);
}

function compactSubtitle(summary: string): string {
  const normalized = compactInlineText(summary)
    .replace(/^(?:本篇|本部|这篇)?传记(?:主要|将|记录|追溯|讲述)?/u, '')
    .trim();
  if (!normalized) return '一段尚待展开的历史侧影';
  return truncateAtBoundary(normalized, SUBTITLE_MAX, SUBTITLE_MIN);
}

function compactInlineText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function echoesDirective(value: string, directives: string[]): boolean {
  const normalized = compactInlineText(value);
  return directives.some(directive => {
    const candidate = compactInlineText(directive);
    return candidate.length > 0 && normalized === candidate;
  });
}

function looksLikeInstruction(value: string): boolean {
  return /^(?:好的?[!！,，。:]?|伊雍[，,:：]|请(?:你|帮|为)|我(?:想|要|希望)|现在(?:继续|开始)|时间跨度[:：])/u
    .test(value);
}

function truncateAtBoundary(value: string, max: number, minimum: number): string {
  const chars = Array.from(value);
  if (chars.length <= max) return value;
  const head = chars.slice(0, max).join('');
  const candidates = [...head.matchAll(/[，、；：。！？·—]/gu)]
    .map(match => match.index ?? -1)
    .filter(index => index >= minimum);
  const boundary = candidates.at(-1);
  const body = boundary === undefined ? head : head.slice(0, boundary);
  return `${body.replace(/[，、；：。！？·—]+$/gu, '')}…`;
}
