import type { SourceSnapshot, WorldbookRetrievalMetadata } from './contracts.ts';

const ENTITY_FIELDS = new Set(('寻根溯源 溯源 墟境探索 历史探查 传记生成 基本信息 基本资料 姓名 名称 性别 种族 年龄 实龄 外貌 外观 外表 性格 身份 职务 别名 又称 旧称 称号 背景 简介 能力 关系 时间 内容 备注 活动地点 活跃于 地点 位置 所在地 所属 所属组织 所属势力 归属 家族 神系 家庭 过往 经历 个人物品 外貌描写 性格特征 背景故事 关键经历 整体印象 穿着风格 显著特征 行为模式 语言风格 特殊体质 配饰 出身 类型 人物背景 角色属性 角色性格指导 角色辅助指导 角色毛色与瞳色指导 角色命名指导 学院 司祭 法师 女王 领主 神明 神祇 未知神祇 name title base_info back_story race identity appearance clothing capabilities personality core_traits behavior_patterns alignment life_tier age gender').split(' '));

/** 只排除可确定不是专名的字段/代码/数字；未知写法仍走原文检索。 */
export function isEntityName(value: string): boolean {
  const name = value.trim();
  return name.length >= 2 && name.length <= 80 && !ENTITY_FIELDS.has(name)
    && !/^\d+(?:\.\d+)?$/u.test(name)
    && !/[\\\n\r<>={}；;。]/u.test(name)
    && !/^(?:对于|针对|若|如果|目前允许)|角色(?:开始|结束)$/u.test(name)
    && !/^(?:const|let|var|return|function)\b|^\s*["']|\{\{|<%/u.test(name);
}

/** 神职/亲属前缀可去掉，真实人名中的中点不能切掉姓氏。 */
export function entityHeadingName(label: string): string {
  const bare = label.replace(/[（(].*$/u, '').trim();
  const parts = bare.split(/[・·]/u).map(part => part.trim());
  return parts.length > 1 && /(?:女神|男神|神明|神祇|圣灵|先祖之魂|圣约之护|低语者|之主|双辉|领域|父亲|母亲|姐姐|妹妹|哥哥|兄长|弟弟|配偶|主人|创造者|制造者)$/u.test(parts[0]!)
    ? parts.slice(1).join('·') : bare;
}

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

/** 名称共证只帮助定位原文，不把所有触发词或作者标签当作人物别名。 */
export function characterReferenceIdentity(snapshot: SourceSnapshot): {
  name: string; aliases: string[];
} | undefined {
  if (snapshot.sourceType !== 'worldbook'
    || /[【\[](?:地点|组织|势力|物品|规则)[】\]]/u.test(snapshot.title)) return undefined;
  const tagged = /[【\[](?:角色|人物|神明)[】\]]/u.test(snapshot.title);
  const title = snapshot.title.replace(/[【\[][^】\]]+[】\]]/gu, '')
    .replace(/[（(].*$/u, '').trim();
  const owner = characterDocumentOwner(snapshot);
  const literal = templateIndependentText(snapshot.content);
  if (!literal.trim()) return undefined;
  const fields = [...literal.matchAll(/^\s*(?:[-*]\s*)?(姓名|名称|别名|又称|旧称|称号|身份|职务|name|title)\s*[:：]\s*(.+)$/gmu)];
  const clean = (value: string) => value.replace(/^[“「『【"']+|[”」』】"']+$/gu, '').trim();
  const valid = (value: string) => isEntityName(value) && value.length <= 50
    && !/[。；;：:，,<>\n]/u.test(value)
    && !/^(?:本体|分身|化身|冒险者|龙姬|人物|角色|神明|未知|不详)$/u.test(value)
    && !/纪元|岁|<%|\{\{/u.test(value);
  const explicitAliases = fields.filter(f => /别名|又称|旧称|称号|^title$/u.test(f[1]!))
    .flatMap(f => f[2]!.split(/[、，,/]/u)).map(clean).filter(valid);
  const identityValues = fields.filter(f => /身份|职务/u.test(f[1]!))
    .flatMap(f => f[2]!.split(/[、，,/]/u)).map(clean);
  const identities = identityValues.map(value => value.replace(/^前/u, '')).filter(valid);
  const named = fields.find(f => /^(?:姓名|名称|name)$/u.test(f[1]!))?.[2]?.replace(/\s*[（(].*$/u, '').trim();
  // 事件内的单人 _info 档案也属于人物；事件入口/多角色史稿不因此改型。
  const profile = /<[^<>\r\n]+_info>/u.test(literal)
    && /^\s*(?:种族|race|性别|gender|identity|生命层级)\s*[:：]/mu.test(literal);
  const profileHeading = profile ? literal.match(/^\s*([^\s:：<>]{2,40})\s*[:：]\s*$/mu)?.[1] : undefined;
  // 带姓名的角色档案必须与题名/包装/称号互相吻合，不能吞掉独立组织补充。
  const corroboratedName = named && valid(named) && (
    title.includes(named.split(/[·・]/u)[0]!)
    || [...explicitAliases, ...identities].includes(title)
    || (profile && title.includes(named.split(/[·・]/u)[0]!))
  );
  if (!tagged && !owner && !corroboratedName && !profileHeading) return undefined;
  const name = owner || (corroboratedName ? named! : profileHeading || title);
  if (!valid(name)) return undefined;
  const metadata = snapshot.metadata as Partial<WorldbookRetrievalMetadata>;
  const keys = metadata.schema === 'eyon.retrieval.worldbook-metadata.v1'
    ? metadata.strategy?.primaryKeys ?? [] : [];
  const givenName = name.split(/[·・]/u)[0]!;
  const titleParts = title.split(/[·・]/u);
  const identityAliases = identities.filter(alias => !/^(?:学生|旅行者|教师|商人|学徒|市民|贵族|骑士|法师)$/u.test(alias)
    && (titleParts.includes(alias) || keys.includes(alias)
      || (alias.length >= 4 && identityValues.includes(`前${alias}`))));
  // 简称需触发键＋姓名子串＋独立正文共证，通用键/共同姓氏不能自动成为别名。
  const proseWithoutName = literal.split(name).join('');
  const shortNames = keys.filter(key => valid(key) && name.includes(key)
    && !name.includes('·') && !name.includes('・')
    && new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=$|[\\s\\d，。；！？：、“”「」]|[的是曾会在不很要将就从把])`, 'u').test(proseWithoutName));
  const formerNames = [...literal.matchAll(/^\s*(?:[-*]\s*)?(?:原名|旧名|曾名|曾用名|本名)(?:为|是)?\s*[:：]\s*[“「]?([^，。；;\n”」]{2,30})/gmu)]
    .map(match => match[1]!.trim()).filter(valid);
  const aliases = [profile ? '' : title, ...explicitAliases, ...identityAliases, ...shortNames, ...formerNames,
  ...formerNames.filter(alias => /[·・]/u.test(alias)).map(alias => alias.split(/[·・]/u)[0]!),
  // 只接受有姓名/标题共证的首段简称；共同姓氏不因触发键而成为别名。
  ...(givenName !== name ? [givenName] : [])];
  return { name, aliases: [...new Set(aliases.filter(alias => valid(alias) && alias !== name))] };
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
  // 保持原始 UTF-16 偏移和换行，证据 span 仍指回未经改写的全文。
  const mask = (value: string) => value.replace(/[^\r\n]/g, ' ');
  for (const block of content.matchAll(/<%([\s\S]*?)%>/gu)) {
    const literal = content.slice(cursor, block.index);
    parts.push(!scopes.includes(true) && !unsafe ? literal : mask(literal));
    cursor = block.index + block[0].length;
    if (/^\s*#/u.test(block[1]!)) { parts.push(mask(block[0])); continue; }
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
    parts.push(mask(block[0]));
  }
  const suffix = content.slice(cursor);
  // 未闭合标签的尾部也不能当作独立字段。
  const incomplete = suffix.indexOf('<%');
  parts.push(!scopes.includes(true) && !unsafe
    ? incomplete < 0 ? suffix : suffix.slice(0, incomplete) + mask(suffix.slice(incomplete))
    : mask(suffix));
  return parts.join('').replace(/\{\{[\s\S]*?\}\}/gu, mask);
}

/** 瞬时识别视图：格式/样式不是实体，原文和 UTF-16 证据偏移保持不变。 */
export function entityRecognitionText(content: string): string {
  const mask = (value: string) => value.replace(/[^\r\n]/g, ' ');
  return templateIndependentText(content)
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)\s*>/giu, mask)
    .replace(/<!--[\s\S]*?-->/gu, mask)
    // 只识别 HTML 标签，不误删角色详情、契约和 UpdateVariable 的实际内容。
    .replace(/<\/?(?:html|head|body|div|span|p|section|article|table|tr|td|th|button|input|textarea|a|img|svg|path|h[1-6])\b[^>]*>/giu, mask)
    .replace(/^\s*#{1,6}\s+[^\r\n]*(?:生成|输出|编译)格式\s*$/gmu, mask)
    // Patch 的值仍可供检索；只屏蔽命令键，不能整段删掉死亡/契约等真实状态。
    .replace(/["'](?:op|path|from)["']\s*:/gu, mask);
}
