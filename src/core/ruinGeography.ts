export interface RuinPlace {
  id: string;
  name: string;
  parent?: string;
  path: string;
}

/** 只读取数据，不执行地理加载脚本或 EJS。循环、重复ID、缺父级均不伪造路径。 */
export function readRuinGeography(raw: unknown, fallbackPaths: readonly string[] = []): RuinPlace[] {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const entries = value && typeof value === 'object'
    ? (value as { places?: unknown }).places : null;
  const source = new Map<string, { name: string; parent?: string }>();
  if (Array.isArray(entries)) for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, name, parent } = entry;
    if (typeof id !== 'string' || typeof name !== 'string' || !id.trim() || !name.trim() || source.has(id)) continue;
    source.set(id, { name: name.trim(), ...(typeof parent === 'string' && parent ? { parent } : {}) });
  }
  const result: RuinPlace[] = [];
  for (const [id, entry] of source) {
    const seen = new Set<string>();
    const names: string[] = [];
    let cursor: string | undefined = id;
    while (cursor && source.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor); const item: { name: string; parent?: string } = source.get(cursor)!; names.unshift(item.name); cursor = item.parent;
    }
    if (cursor) continue;
    result.push({ id, ...entry, path: names.join('-') });
  }
  const paths = new Map(result.map(place => [place.path, place.id]));
  for (const path of fallbackPaths) {
    const parts = path.trim().split('-').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 8 || parts.some(part => /[<>\r\n]/u.test(part))) continue;
    let parent: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('-');
      let id = paths.get(prefix);
      if (!id) {
        id = `path:${prefix}`; paths.set(prefix, id);
        result.push({ id, name: parts[i], ...(parent ? { parent } : {}), path: prefix });
      }
      parent = id;
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN'));
}

export function geographyPathsFromText(text: string): string[] {
  // 只识别明确连字符路径；不把条目作者、角色题名或自然段猜成行政层级。
  const paths: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (/^\s*(?:import\b|export\b|const\b|let\b|function\b|<\/?|\/\/)/u.test(line)) continue;
    for (const match of line.matchAll(/[\p{Script=Han}A-Za-z0-9·]{2,40}(?:-[\p{Script=Han}A-Za-z0-9·]{1,40}){2,7}/gu)) {
      const before = line[(match.index ?? 0) - 1];
      if (before === '/' || before === '_' || before === '<') continue;
      if (/\p{Script=Han}/u.test(match[0]) || /地点|位置|地理|location|place|region/iu.test(line)) paths.push(match[0]);
    }
  }
  return [...new Set(paths)];
}
