import type { SourceSnapshot } from './contracts.ts';

/** 文档归属，不是实体同一性：角色名＋详情包裹共同指向主人物。 */
export function characterDocumentOwner(snapshot: SourceSnapshot): string | undefined {
  if (snapshot.sourceType !== 'worldbook') return undefined;
  const tags = [...snapshot.title.matchAll(/[【\[]([^】\]]+)[】\]]/gu)]
    .map(match => match[1]!.trim());
  const marker = tags.findIndex(tag => /^(?:角色|人物|神明)$/u.test(tag));
  const owner = marker < 0 ? undefined : tags[marker + 1];
  if (!owner || /^(?:WS|DLC|角色|人物|地点|组织|势力|家族|历史)$/iu.test(owner)) return undefined;
  const wrappers = [...snapshot.content.matchAll(/<([^<>\r\n]{2,60}?)\s+角色详情>/gu)]
    .map(match => match[1]!.trim());
  return wrappers.includes(owner) ? owner : undefined;
}

/**
 * 不执行模板。代码和未闭合条件块中的正文不当作硬字段；
 * 独立的字面正文（包括两个模板块之间的基本档案）仍可解析。
 * 无法确定的模板保守保留为原文附件，不试图还原宿主条件。
 */
export function templateIndependentText(content: string): string {
  let cursor = 0;
  const scopes: boolean[] = [];
  let unsafe = false;
  const parts: string[] = [];
  for (const block of content.matchAll(/<%([\s\S]*?)%>/gu)) {
    const literal = content.slice(cursor, block.index);
    parts.push(!scopes.includes(true) && !unsafe ? literal : '\n');
    cursor = block.index + block[0].length;
    if (/^\s*#/u.test(block[1]!)) continue;
    // 字符串/注释中的括号不是控制流；未支持语法只会降低提取，不会执行。
    const code = block[1]!.replace(
      /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu,
      '',
    );
    if (/(?:\b(?:if|else|switch|for|while|function|class)\b|=>)/u.test(code) && !code.includes('{')) unsafe = true;
    // 一个标签内控制词之后新开的块均保守视为有条件；前置普通“{ ... }”
    // 不会误封整个角色档案。嵌套/未知代码可以少提取，但不能放行条件正文。
    let controlled = false;
    for (const token of code.matchAll(/\b(?:if|else|switch|for|while|catch|function|class)\b|=>|[{}]/gu)) {
      if (token[0] === '{') scopes.push(controlled);
      else if (token[0] === '}') {
        if (scopes.length === 0) unsafe = true;
        scopes.pop();
      } else controlled = true;
    }
    parts.push('\n');
  }
  const suffix = content.slice(cursor);
  // 未闭合标签的尾部也不能当作独立字段。
  parts.push(!scopes.includes(true) && !unsafe ? suffix.split('<%')[0]! : '\n');
  return parts.join('');
}
