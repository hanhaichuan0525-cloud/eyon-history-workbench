import type { CastManifest } from '../retrieval/contracts.ts';
import type { RuinGenerationInput } from '../schemas/ruin.ts';

type Source = { sourceId: string; title: string; content: string };
type Person = { name: string; aliases: string[] };
type Node = Person & {
  id: string;
  relationToFocus: string;
  summary?: string;
  profile?: { lifeExperience?: string };
};
type Edge = { from: string; to: string; relationType: string; label: string };

/** 本次请求的临时出场边界，不写回谱系或 Canon。 */
export interface RuinActorPolicy {
  autoGenealogy: boolean;
  requestedSubjects: string[];
  referenceNames: string[];
  genealogyActors: string[];
  blockedGenealogy: Person[];
  unresolvedRelatives: string[];
}

const KIN = /^(?:的)?(父母|双亲|父亲|母亲|爸爸|妈妈|祖父母|祖父|祖母|爷爷|奶奶|外祖父|外祖母|兄弟姐妹|兄弟|姐妹|哥哥|弟弟|姐姐|妹妹|配偶|丈夫|妻子|祖辈|祖先|后代)/u;
const REFERENCE = /(?:参考|参照|借鉴|比照|借用|依照|按照).*(?:人设|性格|风格|设定|资料|背景|经历)|(?:仅|只)(?:作|做|供)?参考|不(?:必|要|用|让).*(?:出场|参与)|(?:不用|不要|排除|不涉及|不包含)/u;
const key = (value: string) => value.normalize('NFKC').replace(/\s/gu, '').toLocaleLowerCase('zh-CN');
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const names = (person: Person) => [...new Set([person.name, ...person.aliases, person.name.split('·')[0]!])].filter(value => key(value).length >= 2).sort((a, b) => b.length - a.length);

/** 姓名只出现在“参考人设”或亲属定语中，不等于本人需要出场。 */
export function ruinNameUse(direction: string, person: Person): 'subject' | 'reference' | 'relative-owner' | 'none' {
  const clauses = direction.split(/[，,。；;\n]/u).filter(Boolean);
  let result: ReturnType<typeof ruinNameUse> = 'none';
  for (const clause of clauses) {
    const alias = names(person).find(name => key(clause).includes(key(name)));
    if (!alias) continue;
    if (REFERENCE.test(clause)) { if (result === 'none') result = 'reference'; continue; }
    const normalizedClause = key(clause);
    const tail = normalizedClause.slice(normalizedClause.indexOf(key(alias)) + key(alias).length);
    if (KIN.test(tail)) { if (result === 'none') result = 'relative-owner'; continue; }
    return 'subject';
  }
  return result;
}

export function scopeRuinGenealogy(
  sources: Source[],
  input: Pick<RuinGenerationInput, 'location' | 'supplementaryDirection' | 'selectedCharacters' | 'autoGenealogy'>,
): { sources: Source[]; policy: RuinActorPolicy } {
  const policy: RuinActorPolicy = {
    autoGenealogy: input.autoGenealogy === true,
    requestedSubjects: [], referenceNames: [], genealogyActors: [],
    blockedGenealogy: [], unresolvedRelatives: [],
  };
  const push = (list: string[], name: string) => { if (!list.some(value => key(value) === key(name))) list.push(name); };
  const seen = new Set<string>();
  const scoped: Source[] = [];
  for (const source of sources) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(source.content); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    // 每族只遍历全族当前视图一次，再投影单人来源，不能把整个族谱送给模型当演员池。
    if (data.schema !== 'eyon.genealogy.current.v1' || !Array.isArray(data.nodes)) continue;
    const nodes = data.nodes.filter(validNode) as Node[];
    const edges = (Array.isArray(data.edges) ? data.edges : []).filter(validEdge) as Edge[];
    const relatedSubjects = new Set<string>();
    const relatedReferences = new Set<string>();
    for (const owner of nodes) for (const alias of names(owner)) {
      // KIN 本身负责词表；这里仅定位紧随所有者姓名的亲属称谓。
      for (const clause of input.supplementaryDirection.split(/[，,。；;\n]/u)) {
        const text = key(clause);
        const offset = text.indexOf(key(alias));
        if (offset < 0) continue;
        const kin = text.slice(offset + key(alias).length).match(KIN)?.[1];
        if (!kin) continue;
        let relatives = findRelatives(owner, kin, nodes, edges);
        const selected = relatives.filter(relative => input.selectedCharacters.some(person => names(relative).some(name => key(name) === key(person.name))));
        if (!pluralKin(kin) && selected.length === 1) relatives = selected;
        const reference = REFERENCE.test(clause);
        if (!reference && (relatives.length === 0 || (!pluralKin(kin) && relatives.length > 1))) {
          push(policy.unresolvedRelatives, `${owner.name}的${kin}`);
          continue;
        }
        for (const relative of relatives) (reference ? relatedReferences : relatedSubjects).add(key(relative.name));
      }
    }
    for (const node of nodes) {
      const use = ruinNameUse(input.supplementaryDirection, node);
      const subject = relatedSubjects.has(key(node.name)) || use === 'subject';
      const manual = input.selectedCharacters.some(person =>
        person.referenceId === `${source.sourceId}:${node.id}`
          || names(node).some(name => key(name) === key(person.name)));
      const reference = relatedReferences.has(key(node.name)) || use === 'reference' || use === 'relative-owner';
      const automatic = policy.autoGenealogy && !reference && localActivity(node, input.location);
      if (subject) push(policy.requestedSubjects, node.name);
      if (reference && !subject) push(policy.referenceNames, node.name);
      if (subject || manual || automatic) push(policy.genealogyActors, node.name);
      else if (!policy.blockedGenealogy.some(person => key(person.name) === key(node.name))) {
        policy.blockedGenealogy.push({ name: node.name, aliases: node.aliases });
      }
      if (!(subject || manual || automatic || reference)) continue;
      const sourceId = `${source.sourceId}:${node.id}`;
      if (seen.has(key(node.name))) continue;
      seen.add(key(node.name));
      scoped.push({ sourceId, title: `${node.name}（谱系人物）`, content: JSON.stringify({
        schema: 'eyon.genealogy.node.v1', node,
        relatedEdges: edges.filter(edge => edge.from === node.id || edge.to === node.id),
        ruinUse: subject || manual || automatic ? 'actor-eligible' : 'reference-only',
        notice: '亲属关系只用于辨识，不授权其他亲属出场。保留原籍；跨境行动须服从本次方向与事件因果。',
      }) });
    }
  }
  // 某人可以在多个族谱里出现；任一明确选择优先于另一族中的未选身份。
  policy.blockedGenealogy = policy.blockedGenealogy.filter(person => !policy.genealogyActors.some(name => key(name) === key(person.name)));
  return { sources: scoped, policy };
}

/** 世界书仍可召回作资料；仅将真正的方向主体升级为 required。 */
export function applyRuinActorPolicy(manifest: CastManifest | undefined, policy: RuinActorPolicy, direction: string): CastManifest | undefined {
  if (!manifest) return manifest;
  return { ...manifest, entries: manifest.entries.map(entry => {
    if (!entry.identity.kinds.includes('person')) return entry;
    const person = { name: entry.identity.canonicalName, aliases: entry.identity.aliases };
    const use = ruinNameUse(direction, person);
    const requested = policy.requestedSubjects.some(name => key(name) === key(person.name)) || use === 'subject'
      || entry.reasons.includes('role-grounded-subject');
    const blocked = policy.blockedGenealogy.some(item => key(item.name) === key(person.name)
      || item.aliases.some(alias => key(alias) === key(person.name))
      || person.aliases.some(alias => key(alias) === key(item.name)));
    if (requested && !entry.reasons.includes('temporal-scope-incompatible')) {
      if (!policy.requestedSubjects.some(name => key(name) === key(person.name))) policy.requestedSubjects.push(person.name);
      return { ...entry, disposition: 'required', role: 'actor', reasons: [...entry.reasons, 'player-requested-subject'] };
    }
    if (blocked) return { ...entry, disposition: 'excluded', role: 'context', reasons: [...entry.reasons, 'genealogy-reference-only'] };
    if (use === 'reference' || use === 'relative-owner') {
      if (!policy.referenceNames.includes(person.name)) policy.referenceNames.push(person.name);
      return { ...entry, disposition: 'optional', role: 'context', reasons: [...entry.reasons, 'player-reference-only'] };
    }
    return entry;
  }) };
}

export function blockedRuinActor(policy: RuinActorPolicy | undefined, name: string): boolean {
  if (!policy) return false;
  if (policy.requestedSubjects.some(value => key(value) === key(name)) || policy.genealogyActors.some(value => key(value) === key(name))) return false;
  return policy.blockedGenealogy.some(person => names(person).some(alias => key(alias) === key(name)));
}

function findRelatives(owner: Node, kin: string, nodes: Node[], edges: Edge[]): Node[] {
  const type = /祖辈|祖先/u.test(kin) ? 'ancestor' : /祖|爷|奶/u.test(kin) ? 'grandparent' : /父|母|爸爸|妈妈|双亲/u.test(kin) ? 'parent'
    : /配偶|丈夫|妻子/u.test(kin) ? 'spouse' : /后代/u.test(kin) ? 'descendant'
      : 'sibling';
  const endpoints = new Set(edges.flatMap(edge => {
    if (type === 'parent' && edge.relationType === 'child' && edge.from === owner.id) return [edge.to];
    if (edge.relationType !== type) return [];
    if (edge.to === owner.id) return [edge.from];
    if ((type === 'spouse' || type === 'sibling') && edge.from === owner.id) return [edge.to];
    return [];
  }));
  const parentsOf = (id: string) => edges.flatMap(edge => edge.relationType === 'parent' && edge.to === id ? [edge.from]
    : edge.relationType === 'child' && edge.from === id ? [edge.to] : []);
  const childrenOf = (id: string) => edges.flatMap(edge => edge.relationType === 'parent' && edge.from === id ? [edge.to]
    : edge.relationType === 'child' && edge.to === id ? [edge.from] : []);
  // 族谱通常只存父母边；祖辈/后代必须沿图走，不能拿关系标签猜一个人。
  if (type === 'grandparent') for (const parent of parentsOf(owner.id)) {
    for (const id of parentsOf(parent)) endpoints.add(id);
  }
  if (type === 'sibling') for (const parent of parentsOf(owner.id)) {
    for (const id of childrenOf(parent)) if (id !== owner.id) endpoints.add(id);
  }
  if (type === 'ancestor' || type === 'descendant') {
    const next = type === 'ancestor' ? parentsOf : childrenOf;
    let frontier = [owner.id];
    const visited = new Set(frontier);
    for (let depth = 0; depth < 8 && frontier.length; depth += 1) {
      frontier = frontier.flatMap(id => next(id)).filter(id => {
        if (visited.has(id)) return false;
        visited.add(id); endpoints.add(id); return true;
      });
    }
  }
  const candidates = nodes.filter(node => endpoints.has(node.id) && node.id !== owner.id);
  if (pluralKin(kin) || kin === '配偶') return candidates;
  const labels: Record<string, RegExp> = {
    父亲: /父亲|爸爸|父[子女]/u, 爸爸: /父亲|爸爸|父[子女]/u,
    母亲: /母亲|妈妈|母[子女]/u, 妈妈: /母亲|妈妈|母[子女]/u,
    祖父: /(?:^|[^外])祖父|爷爷/u, 爷爷: /(?:^|[^外])祖父|爷爷/u, 祖母: /(?:^|[^外])祖母|奶奶/u, 奶奶: /(?:^|[^外])祖母|奶奶/u,
    外祖父: /外祖父/u, 外祖母: /外祖母/u,
    哥哥: /哥哥|兄长/u, 弟弟: /弟弟/u, 姐姐: /姐姐|姊姊/u, 妹妹: /妹妹/u,
    丈夫: /丈夫|夫/u, 妻子: /妻子|妻/u,
  };
  const label = labels[kin];
  const identified = label ? candidates.filter(node => label.test(node.relationToFocus)
    || edges.some(edge => (edge.from === node.id || edge.to === node.id)
      && (edge.from === owner.id || edge.to === owner.id) && label.test(edge.label))) : candidates;
  return identified.length ? identified : candidates;
}

function pluralKin(kin: string): boolean { return /父母|双亲|祖父母|兄弟姐妹|兄弟|姐妹|祖辈|祖先|后代/u.test(kin); }
function localActivity(node: Node, location: string): boolean {
  const place = key(location).split(/[-—\/＞>]/u).filter(Boolean).at(-1);
  if (!place || place.length < 2) return false;
  const text = key(`${node.summary ?? ''}；${node.profile?.lifeExperience ?? ''}`);
  const p = escaped(place);
  // 地名偶然提及、后嗣任职或种族推断均不足以证明本人的在地活动。
  return new RegExp(`(?:出生|居住|定居|迁居|生活|任职|活动|工作|服役|经商|谋生)(?:于|在|到|至)?${p}|${p}(?:的)?(?:居民|工匠|军官|商人|抄工|人)`, 'u').test(text)
    && !new RegExp(`(?:未|不|没有|从未)[^；。]{0,8}${p}`, 'u').test(text);
}
function validNode(value: unknown): value is Node {
  const node = value as Partial<Node> | null;
  return !!node && typeof node.id === 'string' && typeof node.name === 'string' && Array.isArray(node.aliases)
    && node.aliases.every(alias => typeof alias === 'string') && typeof node.relationToFocus === 'string';
}
function validEdge(value: unknown): value is Edge {
  const edge = value as Partial<Edge> | null;
  return !!edge && typeof edge.from === 'string' && typeof edge.to === 'string' && typeof edge.relationType === 'string' && typeof edge.label === 'string';
}
