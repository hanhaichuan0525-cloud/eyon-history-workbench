import { resolveBiographyDisplayIdentity } from './biographyIdentity.ts';

const FORBIDDEN_ROOT_TRACE_CONTENT = [
  '<item_info>',
  '[RuinTrace]',
  '<butterfly_panel>',
  '<UpdateVariable>',
];

export const ROOT_TRACE_CHECKER_REVISION = 'semantic-v5';

export interface BiographyRootTraceInput {
  /** 唯一书签键（internal.79 v9）：requestId 尾 8 位——同名传记共存时书签 id 不冲突；旧调用可缺省（渲染为空行） */
  bookId?: string;
  playerDirective: {
    primaryDirection: string;
  };
  target: {
    name: string;
  };
  presentation?: {
    title?: string;
    subtitle?: string;
  };
  span: {
    // 展示标签由脚本按跨度自适应生成；组装前可能缺失，渲染时兜底为空串
    label?: string;
  };
  origin: {
    title: string;
    content: string;
  };
  stages: Array<{
    type: 'stable' | 'transition' | 'turbulent';
    title: string;
    span: string;
    content: string;
  }>;
  status: {
    title: string;
    content: string;
  };
  summary: string;
}

export interface BiographyRootTraceSemantic {
  bookId: string;
  title: string;
  subtitle: string;
  span: string;
  originTitle: string;
  origin: string;
  stages: Array<{
    type: keyof typeof STAGE_TYPE_LABELS;
    title: string;
    span: string;
    content: string;
  }>;
  statusTitle: string;
  status: string;
  summary: string;
}

const STAGE_TYPE_LABELS = {
  stable: '稳定期',
  transition: '过渡期',
  turbulent: '动荡期',
} as const;

function escapeHtml(source: string): string {
  return source
    .replace(/\r\n?/gu, '\n')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    // RootTrace uses line starts as field boundaries. Keep authored line breaks
    // visible without letting prose imitate a top-level field marker.
    .replaceAll('\n', '&#10;');
}

function decodeHtml(source: string): string {
  const namedEntities: Record<string, string> = {
    amp: '&',
    gt: '>',
    lt: '<',
    quot: '"',
    apos: "'",
  };
  return source
    .replace(/&#(x[0-9a-f]+|\d+);/giu, (_, token: string) => {
      const radix = token[0]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? token.slice(1) : token;
      const codePoint = Number.parseInt(digits, radix);
      return Number.isInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _;
    })
    .replace(/&(amp|gt|lt|quot|apos);/giu, (_, name: string) => (
      namedEntities[name.toLowerCase()] ?? _
    ));
}

function canonicalSourceText(source: string): string {
  return source
    .replace(/\r\n?/gu, '\n')
    .normalize('NFC')
    .trim();
}

function canonicalRenderedText(source: string): string {
  return canonicalSourceText(decodeHtml(source));
}

function expectedRootTraceSemantic(
  biography: BiographyRootTraceInput,
): BiographyRootTraceSemantic {
  const identity = resolveBiographyDisplayIdentity(biography);
  return {
    bookId: canonicalSourceText(biography.bookId ?? ''),
    title: canonicalSourceText(identity.titleText),
    subtitle: canonicalSourceText(identity.subtitle),
    span: canonicalSourceText(biography.span.label ?? ''),
    originTitle: canonicalSourceText(biography.origin.title),
    origin: canonicalSourceText(biography.origin.content),
    stages: biography.stages.map(stage => ({
      type: stage.type,
      title: canonicalSourceText(stage.title),
      span: canonicalSourceText(stage.span),
      content: canonicalSourceText(stage.content),
    })),
    statusTitle: canonicalSourceText(biography.status.title),
    status: canonicalSourceText(biography.status.content),
    summary: canonicalSourceText(biography.summary),
  };
}

export function parseBiographyRootTrace(raw: string): BiographyRootTraceSemantic {
  const normalized = validateRootTrace(raw);
  const fields = normalized.match(
    /^\[RootTrace\]\nBookId:: ([\s\S]*?)\nTitle:: ([\s\S]*?)\nSubtitle:: ([\s\S]*?)\nSpan:: ([\s\S]*?)\nOriginTitle:: ([\s\S]*?)\nOrigin:: ([\s\S]*?)\nPeriods:: ([\s\S]*?)\nStatusTitle:: ([\s\S]*?)\nStatus:: ([\s\S]*?)\nSummary:: ([\s\S]*?)\n\[\/RootTrace\]$/u,
  );
  if (!fields) {
    throw new Error('RootTrace field order or field boundary is invalid');
  }

  const title = canonicalRenderedText(fields[2] ?? '');
  const titleMatch = title.match(/^《([\s\S]+)》$/u);
  if (!titleMatch) {
    throw new Error('RootTrace Title must use 《target》');
  }

  const periods = fields[7] ?? '';
  const stagePattern = /<details class="eybi-stage"><summary class="eybi-stage-title">([\s\S]*?)<\/summary><div class="eybi-stage-body"><div class="eybi-v eybi-pre eybi-entries">([\s\S]*?)<\/div><\/div><\/details>/gu;
  const stages: BiographyRootTraceSemantic['stages'] = [];
  let cursor = 0;
  for (const match of periods.matchAll(stagePattern)) {
    if (match.index !== cursor) {
      throw new Error(`RootTrace Periods contains invalid markup at offset ${cursor}`);
    }
    cursor = match.index + match[0].length;
    const heading = canonicalRenderedText(match[1] ?? '');
    const headingMatch = heading.match(/^([\s\S]+)｜(稳定期|过渡期|动荡期)\(([\s\S]+)\)$/u);
    if (!headingMatch) {
      throw new Error(`RootTrace stage heading is invalid: ${heading}`);
    }
    const type = (Object.entries(STAGE_TYPE_LABELS)
      .find(([, label]) => label === headingMatch[2])?.[0]) as keyof typeof STAGE_TYPE_LABELS | undefined;
    if (!type) {
      throw new Error(`RootTrace stage type is invalid: ${headingMatch[2]}`);
    }
    stages.push({
      type,
      title: canonicalRenderedText(headingMatch[1] ?? ''),
      span: canonicalRenderedText(headingMatch[3] ?? ''),
      content: canonicalRenderedText(match[2] ?? ''),
    });
  }
  if (cursor !== periods.length) {
    throw new Error(`RootTrace Periods contains invalid markup at offset ${cursor}`);
  }

  return {
    // The complete Title field was decoded before extracting 《...》.
    // Decoding the captured value again would corrupt literal entity text.
    bookId: canonicalRenderedText(fields[1] ?? ''),
    title: canonicalSourceText(titleMatch[1] ?? ''),
    subtitle: canonicalRenderedText(fields[3] ?? ''),
    span: canonicalRenderedText(fields[4] ?? ''),
    originTitle: canonicalRenderedText(fields[5] ?? ''),
    origin: canonicalRenderedText(fields[6] ?? ''),
    stages,
    statusTitle: canonicalRenderedText(fields[8] ?? ''),
    status: canonicalRenderedText(fields[9] ?? ''),
    summary: canonicalRenderedText(fields[10] ?? ''),
  };
}

export function assertBiographyRootTraceMatchesStructuredData(
  biography: BiographyRootTraceInput,
  rootTrace: string,
): void {
  const expected = expectedRootTraceSemantic(biography);
  const actual = parseBiographyRootTrace(rootTrace);
  const scalarFields: Array<keyof Omit<BiographyRootTraceSemantic, 'stages'>> = [
    // bookId 是派生展示键（requestId 尾 8 位），不参与内容语义比对。
    'title',
    'subtitle',
    'span',
    'originTitle',
    'origin',
    'statusTitle',
    'status',
    'summary',
  ];
  for (const field of scalarFields) {
    if (actual[field] !== expected[field]) {
      throwSemanticMismatch(field, expected[field], actual[field]);
    }
  }
  if (actual.stages.length !== expected.stages.length) {
    throw new Error('RootTrace semantic mismatch at stages.length');
  }
  expected.stages.forEach((stage, index) => {
    const rendered = actual.stages[index];
    for (const field of ['type', 'title', 'span', 'content'] as const) {
      if (rendered?.[field] !== stage[field]) {
        throwSemanticMismatch(
          `stages[${index}].${field}`,
          stage[field],
          rendered?.[field] ?? '',
        );
      }
    }
  });
}

function throwSemanticMismatch(field: string, expected: string, actual: string): never {
  let firstDifference = 0;
  const sharedLength = Math.min(expected.length, actual.length);
  while (firstDifference < sharedLength && expected[firstDifference] === actual[firstDifference]) {
    firstDifference += 1;
  }
  throw new Error(
    `RootTrace semantic mismatch at ${field}`
    + ` (checker=${ROOT_TRACE_CHECKER_REVISION}; expectedLength=${expected.length};`
    + ` actualLength=${actual.length}; firstDifference=${firstDifference})`,
  );
}

export function validateRootTrace(raw: string): string {
  const normalized = raw.replace(/\r\n?/gu, '\n').trim();

  if (!normalized.startsWith('[RootTrace]\n')) {
    throw new Error('RootTrace must start with [RootTrace]');
  }
  if (!normalized.endsWith('\n[/RootTrace]')) {
    throw new Error('RootTrace must end with [/RootTrace]');
  }
  if (FORBIDDEN_ROOT_TRACE_CONTENT.some(token => normalized.includes(token))) {
    throw new Error('RootTrace contains content owned by another workflow');
  }
  if (/<details\b[^>]*\bopen(?:\s|=|>)/iu.test(normalized)) {
    throw new Error('RootTrace details must be collapsed by default');
  }

  return normalized;
}

/**
 * RootTrace is a presentation artifact. Generate it only after the structured
 * biography has passed schema, source and chronology validation so the model
 * never has to maintain two copies of the same prose.
 */
export function renderBiographyRootTrace(
  biography: BiographyRootTraceInput,
): string {
  const identity = resolveBiographyDisplayIdentity(biography);
  const periods = biography.stages.map(stage => {
    const stageLabel = STAGE_TYPE_LABELS[stage.type];
    const heading = `${stage.title}｜${stageLabel}(${stage.span})`;
    return [
      '<details class="eybi-stage">',
      `<summary class="eybi-stage-title">${escapeHtml(heading)}</summary>`,
      '<div class="eybi-stage-body">',
      `<div class="eybi-v eybi-pre eybi-entries">${escapeHtml(stage.content)}</div>`,
      '</div>',
      '</details>',
    ].join('');
  }).join('');

  return validateRootTrace([
    '[RootTrace]',
    `BookId:: ${escapeHtml(biography.bookId ?? '')}`,
    `Title:: ${escapeHtml(identity.title)}`,
    `Subtitle:: ${escapeHtml(identity.subtitle)}`,
    `Span:: ${escapeHtml(biography.span.label ?? '')}`,
    `OriginTitle:: ${escapeHtml(biography.origin.title)}`,
    `Origin:: ${escapeHtml(biography.origin.content)}`,
    `Periods:: ${periods}`,
    `StatusTitle:: ${escapeHtml(biography.status.title)}`,
    `Status:: ${escapeHtml(biography.status.content)}`,
    `Summary:: ${escapeHtml(biography.summary)}`,
    '[/RootTrace]',
  ].join('\n'));
}
