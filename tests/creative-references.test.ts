import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_BUTTERFLY_REFERENCES, ACTIVE_BUTTERFLY_SELECT_KEYS, BUTTERFLY_MEANINGS, BUTTERFLY_EXAMPLE_NOTICE, activeButterflyReferences, butterflyAbsurdityMeaning, BUTTERFLY_OPTIONS, BUTTERFLY_PRESETS, RUIN_STYLE_OPTIONS, ButterflyReferencesSchema, createReferencedRuinMaterials, defaultRuinReferences, randomButterflyReferences, randomRuinReferences, renderButterflyReferences, renderRuinCreativeReferences, absurdityLabel, ruinStyleMeaning } from '../src/core/creativeReferences.ts';
import { readRuinGeography, geographyPathsFromText } from '../src/core/ruinGeography.ts';
import { ScriptWorkbenchSettings } from '../src/runtime/workbenchSettings.ts';
import { RuinGenerationInputSchema } from '../src/schemas/ruin.ts';
import { RUIN_EXAMPLE_NOTICE, renderRuinStyleReminder, ruinStyleLabel } from '../src/core/creativeReferences.ts';

function input() {
  const refs = { ...defaultRuinReferences(), periods: ['stable', 'stable', 'stable'] as const };
  return RuinGenerationInputSchema.parse({ era: '复兴纪元', start: null, end: null, location: '亚尔夫海姆-幽谷-溪畔', supplementaryDirection: '二叶幼年玩积木', selectedCharacters: [], wave: { level: 'ripple', candidateCount: 3 }, materials: createReferencedRuinMaterials(3, { ...refs, periods: [...refs.periods] }), creativeReferences: refs });
}

test('离奇与领域独立，退役选项存档值不再影响新提示', () => {
  for (const absurdity of [0, 21, 41, 61, 100]) {
    for (const domain of BUTTERFLY_OPTIONS.domain) {
      const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, absurdity, domain };
      const prompt = renderButterflyReferences(refs);
      assert.match(prompt, /低离奇也可影响国家，高离奇也可只改变一个人/u);
      assert.equal(prompt, renderButterflyReferences({ ...refs,
        legend: '史诗回响', evolution: '代际接力', manifestation: '传闻与作品' }));
      assert.doesNotMatch(prompt, /世界神系与自然条件仍成立|不等于改写神明本体/u);
    }
  }
});

test('三候选可全部稳定，旧输入壳保留但不向提示词投递骰表题材', () => {
  const draft = input();
  const prompt = renderRuinCreativeReferences(draft);
  assert.deepEqual(draft.materials.map(item => item.periodType), ['stable', 'stable', 'stable']);
  assert.match(prompt, /稳定不是人人幸福/u);
  assert.match(prompt, /不是四套文风抽签/u);
  assert.match(prompt, /起止状态可以相同/u);
  assert.doesNotMatch(prompt, /依玩家内容与所选时期展开/u);
});
test('32项讲述气质各有明确写法与短例，组合只使用选中的释义', () => {
  const definitions: string[] = [];
  for (const group of ['telling', 'pace', 'mood'] as const) {
    for (const option of RUIN_STYLE_OPTIONS[group]) {
      const meaning = ruinStyleMeaning(group, option);
      definitions.push(meaning);
      assert.match(meaning, /^含义: .+\n写法: .+如：.+$/u, `${group}/${option} 分离含义和实际写法`);
      assert.doesNotMatch(meaning, /。/u);
      assert.ok(!meaning.includes('二叶'), '通用例子不向其他题材注入角色');
      const draft = input(); draft.creativeReferences![group] = option as never;
      const prompt = renderRuinCreativeReferences(draft);
      assert.ok(prompt.includes(meaning));
      assert.doesNotMatch(prompt, /undefined/u);
      for (const other of RUIN_STYLE_OPTIONS[group]) {
        if (other !== option) assert.ok(!prompt.includes(ruinStyleMeaning(group, other)), `${option}不投递${other}的释义`);
      }
    }
  }
  assert.equal(definitions.length, 32);
  assert.equal(new Set(definitions).size, 32, '三组自动选项也有各自的方法');
  const draft = input(); Object.assign(draft.creativeReferences!, { telling: '多方讲述', pace: '起伏鲜明', mood: '悲伤惋惜' });
  const prompt = renderRuinCreativeReferences(draft);
  assert.match(prompt, /各贡献一块不同的信息/u);
  assert.match(prompt, /玩积木也可由搭成、倒塌/u);
  assert.match(prompt, /不强制死亡/u);
  assert.match(prompt, /先让所选写法影响提纲/u);
  assert.match(prompt, /不因未满足偏好重试、报错或截断正文/u);
});

test('讲述、节奏与情绪分别落实信息、场面及语言，不只换标签', () => {
  const expectations = {
    telling: ['理解路径', '为什么开始', '动作、声音、空间与对话', '注意、愿望与误解', '先前细节', '不同的信息', '回望的语气', '谁为何知道', '交谈本身', '使用、递交', '时代的窗口'],
    pace: ['篇幅留给', '相同篇幅', '动作带来回应', '压缩重复背景', '期待、落差', '缩短行动间隔', '消化的间隙', '新的意味'],
    mood: ['语言温度', '小小错位', '具体照顾', '成年关系', '正常节律被打断', '准确动作和留白', '值得珍惜', '实际行动', '所得与所失', '形态、尺度', '不合常态', '各自的道理', '距离、缺席'],
  };
  for (const group of ['telling', 'pace', 'mood'] as const) {
    RUIN_STYLE_OPTIONS[group].forEach((option, index) => {
      assert.ok(ruinStyleMeaning(group, option).includes(expectations[group][index]!), `${group}/${option}必须说明可用的写法`);
    });
  }
  assert.match(ruinStyleMeaning('telling', '回忆讲述'), /不获取事件终点后的知识/u);
  assert.match(ruinStyleMeaning('telling', '逐步揭示'), /已知事实仍准确/u);
  assert.match(ruinStyleMeaning('pace', '舒缓描写'), /紧急行动仍按真实速度/u);
  assert.match(ruinStyleMeaning('mood', '甜蜜暧昧'), /不把幼年人物成人化/u);
});

test('每类示例提醒只出现一次，正文末尾仅回看选择，不叠加整套释义', () => {
  const draft = input(); Object.assign(draft.creativeReferences!, { telling: '现场展开', pace: '舒缓描写', mood: '冷静克制' });
  const prompt = renderRuinCreativeReferences(draft);
  assert.equal(prompt.split(RUIN_EXAMPLE_NOTICE).length - 1, 4, '时期和三类气质各一次，不每项重复');
  assert.equal(prompt.split('写作抓手：').length - 1, 3);
  for (const group of ['telling', 'pace', 'mood'] as const) {
    assert.equal(prompt.split(ruinStyleMeaning(group, draft.creativeReferences![group])).length - 1, 1);
  }
  const reminder = renderRuinStyleReminder(draft);
  assert.match(reminder, /现场讲述/u); assert.match(reminder, /舒缓细写/u); assert.match(reminder, /冷静克制/u);
  assert.match(reminder, /无需输出说明、评分或新字段/u);
  assert.doesNotMatch(reminder, /如：|仅作示例|多方讲述|悲伤惋惜/u);
  for (const unused of ['多方讲述', '回忆讲述', '起伏鲜明', '热烈昂扬']) assert.ok(!prompt.includes(`「${unused}」`));
});

test('无新配置的旧输入沿用自动风格，未知选项安全回退且不改候选', () => {
  const draft = input(); delete draft.creativeReferences;
  const materials = structuredClone(draft.materials);
  const prompt = renderRuinCreativeReferences(draft);
  for (const group of ['telling', 'pace', 'mood'] as const) {
    assert.equal(ruinStyleMeaning(group, '未知旧值'), ruinStyleMeaning(group, '随内容自动'));
    assert.ok(prompt.includes(ruinStyleMeaning(group, '随内容自动')));
  }
  assert.deepEqual(draft.materials, materials);
  assert.match(prompt, /不是四套文风抽签/u); assert.match(prompt, /起止状态可以相同/u);
});

test('四字显示名称不改变旧存储值，32项可保存重读且只投递选中内容', () => {
  assert.equal(ruinStyleLabel('pace', '循序推进'), '循序渐进');
  assert.equal(ruinStyleLabel('telling', '多方讲述'), '多方视角');
  assert.equal(ruinStyleLabel('mood', '复杂交织'), '五味杂陈');
  let variables: Record<string, unknown> = {};
  const scope = { characterKey: '选项兼容卡', chatId: '选项兼容聊天' };
  const settings = new ScriptWorkbenchSettings({
    getScriptVariables: () => variables, replaceScriptVariables: value => { variables = value; },
  }, () => scope);
  for (const group of ['telling', 'pace', 'mood'] as const) {
    const labels = RUIN_STYLE_OPTIONS[group].map(value => ruinStyleLabel(group, value));
    assert.ok(labels.every(value => [...value].length === 4));
    assert.equal(new Set(labels).size, labels.length);
    for (const option of RUIN_STYLE_OPTIONS[group]) {
      const draft = input(); draft.creativeReferences![group] = option as never;
      settings.setRuinDraft(scope, draft);
      const restored = settings.getRuinDraft(scope)!;
      assert.equal(restored.creativeReferences![group], option, '原键值不得被显示名称覆盖');
      assert.ok(renderRuinCreativeReferences(restored).includes(ruinStyleMeaning(group, option)));
    }
  }
});

test('防模板指导从本次事实出发，不把求新变成强制反转或领域配额', () => {
  const ruin = renderRuinCreativeReferences(input());
  const butterfly = renderButterflyReferences(DEFAULT_BUTTERFLY_REFERENCES);
  assert.match(ruin, /不先从短例选择剧情再套入角色/u);
  assert.match(butterfly, /完整实际行动.*历史条件/su);
  assert.match(butterfly, /原演员、物件与题材可以退出/u);
  assert.match(butterfly, /不强求每步跨领域或放大/u);
  assert.match(butterfly, /不为避免相似而刻意反转/u);
  assert.match(butterfly, /不另加分析字段/u);
});

test('五项主参考和可选领域不预定结局，九键存档保持兼容', () => {
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: 100, focus: '某个家庭' };
  const text = renderButterflyReferences(refs);
  assert.match(text, /极诞/u);
  assert.match(text, /范围是主要观察尺度，不是实际影响的天花板/u);
  assert.match(text, /个人尺度也须承接已经结束的大战/u);
  assert.match(text, /时代回响可以是一场短促的改写世界事件/u);
  assert.match(text, /三件事.*锚点逐字恢复/su);
  assert.equal(Object.keys(DEFAULT_BUTTERFLY_REFERENCES).length, 9);
  assert.deepEqual(Object.keys(activeButterflyReferences(refs)), ['scope', 'focus', 'intensity', 'absurdity', 'mood', 'domain']);
  assert.deepEqual(ButterflyReferencesSchema.parse(refs), refs);
  assert.ok(BUTTERFLY_PRESETS.length >= 3);
  assert.doesNotMatch(text, /undefined|传奇感「|演化方式「|显现方式「/u);
});

test('31个在用离散选项有独立含义、承接写法及短例，只发送选中释义', () => {
  const meanings: string[] = [];
  for (const group of ACTIVE_BUTTERFLY_SELECT_KEYS) {
    for (const option of BUTTERFLY_OPTIONS[group]) {
      const meaning = (BUTTERFLY_MEANINGS[group] as Record<string, string>)[option];
      assert.match(meaning, /如：/u);
      assert.match(meaning, /^含义: .+\n写法: .+\n如：.+$/u);
      assert.ok(meaning.length >= 100 && meaning.length < 300, '选项解释足够具体但不堆入整套公共规则');
      assert.doesNotMatch(meaning, /。/u);
      meanings.push(meaning);
      const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, [group]: option });
      assert.ok(prompt.includes(meaning), group + '/' + option);
      for (const other of BUTTERFLY_OPTIONS[group].filter(value => value !== option)) {
        assert.ok(!prompt.includes((BUTTERFLY_MEANINGS[group] as Record<string, string>)[other]));
      }
    }
  }
  assert.equal(meanings.length, 31);
  assert.equal(new Set(meanings).size, 31);
});

test('示例提醒每个大类仅一次，不重复塞入每个选项', () => {
  const prompt = renderButterflyReferences(DEFAULT_BUTTERFLY_REFERENCES);
  assert.equal(prompt.split(BUTTERFLY_EXAMPLE_NOTICE).length - 1, 6);
  for (const meanings of Object.values(BUTTERFLY_MEANINGS)) {
    for (const meaning of Object.values(meanings)) assert.ok(!meaning.includes(BUTTERFLY_EXAMPLE_NOTICE));
  }
  assert.match(prompt, /关注对象.*不是参与者名单或期望结局/su);
  assert.match(prompt, /不因文风不符返工或报错/u);
});

test('五档离奇释义边界明确，与观察尺度互不绑定', () => {
  const values = [0,20,21,40,41,60,61,80,81,100];
  assert.deepEqual(values.map(absurdityLabel), ['朴素','朴素','微妙','微妙','离奇','离奇','奇诞','奇诞','极诞','极诞']);
  for (const value of values) {
    const meaning = butterflyAbsurdityMeaning(value);
    assert.ok(meaning.startsWith(absurdityLabel(value)));
    assert.match(meaning, /如：/u);
    assert.ok(renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: value }).includes(meaning));
  }
});

test('随机只改在用选项，默认对象不突变，旧字段继续可解析', () => {
  const before = JSON.stringify(DEFAULT_BUTTERFLY_REFERENCES);
  for (const value of [-1, 0, 1, NaN, Infinity]) {
    const randomized = randomButterflyReferences(() => value);
    assert.doesNotThrow(() => ButterflyReferencesSchema.parse(randomized));
    for (const key of ['legend', 'evolution', 'manifestation'] as const) {
      assert.equal(randomized[key], DEFAULT_BUTTERFLY_REFERENCES[key]);
    }
    assert.equal(randomRuinReferences(5, () => value).periods.length, 5);
  }
  assert.equal(JSON.stringify(DEFAULT_BUTTERFLY_REFERENCES), before);
});

test('城市和聚落可新生或消失，时代回响不锁为长期风俗', () => {
  assert.match(BUTTERFLY_MEANINGS.scope.城市, /新城、迁都与旧城消失/u);
  assert.match(BUTTERFLY_MEANINGS.scope.聚落, /新村形成.*旧寨消失/u);
  assert.match(BUTTERFLY_MEANINGS.intensity.时代回响, /不要求漫长积累.*一瞬止战.*大战终止/su);
});

test('地理加载数据保留真实父子关系；循环和缺父不伪造层级', () => {
  const raw = { places: [{ id:'c',name:'大陆' },{ id:'s',name:'小城',parent:'c' },{ id:'m',name:'市场',parent:'s' },{ id:'bad',name:'缺父',parent:'none' },{ id:'a',name:'环甲',parent:'b' },{ id:'b',name:'环乙',parent:'a' },{ id:'s',name:'覆盖小城' }] };
  const places = readRuinGeography(JSON.stringify(raw));
  assert.equal(places.find(item=>item.id==='c')?.name, '阿斯塔利亚大陆');
  assert.equal(places.find(item=>item.id==='m')?.path, '阿斯塔利亚大陆-小城-市场');
  assert.equal(places.length,3);
  assert.deepEqual(readRuinGeography('invalid'),[]);
});
test('无插件时只读取显式地点路径，EJS和模块导入不冒充地点', () => {
  const content = '位置: 大陆-帝国-港城-借阅台\nimport x from eyon-history-workbench\n<eyon-history-workbench>\nconst path = 大陆-帝国-代码\nLocation: Continent-Empire-Port';
  const paths = geographyPathsFromText(content);
  assert.deepEqual(paths, ['大陆-帝国-港城-借阅台', 'Continent-Empire-Port']);
  const places = readRuinGeography(null, paths);
  assert.equal(places.find(item=>item.path==='阿斯塔利亚大陆-帝国-港城-借阅台')?.name,'借阅台');
  assert.equal(places.find(item=>item.path==='阿斯塔利亚大陆-帝国-港城')?.name,'港城');
});

test('地点索引仅补全大陆根简称，保留ID、父级和其他地名，不改宿主数据', () => {
  const raw = { places: [
    { id:'c',name:' 大陆 ' },
    { id:'e',name:'奥古斯提姆帝国',parent:'c' },
    { id:'p',name:'艾瑟尼亚省',parent:'e' },
    { id:'s',name:'艾瑟嘉德',parent:'p' },
    { id:'other',name:'另一片大陆' },
    { id:'local',name:'大陆',parent:'other' },
  ] };
  const before = structuredClone(raw);
  const places = readRuinGeography(raw);
  assert.deepEqual(places.find(place=>place.id==='c'), { id:'c',name:'阿斯塔利亚大陆',path:'阿斯塔利亚大陆' });
  assert.deepEqual(places.find(place=>place.id==='s'), { id:'s',name:'艾瑟嘉德',parent:'p',path:'阿斯塔利亚大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德' });
  assert.equal(places.find(place=>place.id==='local')?.path, '另一片大陆-大陆');
  assert.deepEqual(raw,before);
});

test('地点回退路径统一根简称，完整名称不重复补写，同一路径合并', () => {
  const paths = ['大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德', '阿斯塔利亚大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德', '大陆东部-港城-码头'];
  const places = readRuinGeography(null, paths);
  assert.equal(places.filter(place=>place.name==='艾瑟嘉德').length,1);
  assert.equal(places.find(place=>place.name==='艾瑟嘉德')?.path, '阿斯塔利亚大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德');
  assert.ok(places.some(place=>place.path==='大陆东部-港城-码头'));
  assert.equal(paths[0],'大陆-奥古斯提姆帝国-艾瑟尼亚省-艾瑟嘉德');
  const loaded = readRuinGeography({ places:[{ id:'root',name:'阿斯塔利亚大陆' }] }, paths);
  assert.equal(loaded.filter(place=>place.path==='阿斯塔利亚大陆').length,1);
  assert.equal(loaded.find(place=>place.name==='奥古斯提姆帝国')?.parent,'root');
});
test('草稿与确认按卡、聊天、轮次隔离；清理不碰别的聊天或脚本变量', () => {
  let variables: Record<string,unknown> = { unrelated: { value:7 } };
  const a = { characterKey:'卡甲',chatId:'聊天一' }, b = { characterKey:'卡乙',chatId:'聊天一' };
  let current = a;
  const settings = new ScriptWorkbenchSettings({ getScriptVariables:()=>variables, replaceScriptVariables:next=>{variables=next;} },()=>current);
  settings.setRuinDraft(a,input());
  settings.setButterflyReferences(a,'run-1',DEFAULT_BUTTERFLY_REFERENCES,true);
  settings.setButterflyReferences(b,'run-1',{ ...DEFAULT_BUTTERFLY_REFERENCES,absurdity:100 },false);
  assert.equal(settings.getButterflyReferences(a,'run-2'),null);
  assert.equal(settings.getButterflyReferences(a,'run-1')?.confirmed,true);
  current=b; assert.equal(settings.getRuinDraft(b),null);
  assert.equal(settings.getButterflyReferences(b,'run-1')?.references.absurdity,100);
  settings.clearButterflyReferences(a);
  assert.equal(settings.getButterflyReferences(a,'run-1'),null);
  assert.equal(settings.getButterflyReferences(b,'run-1')?.references.absurdity,100);
  assert.deepEqual(variables.unrelated,{value:7});
  assert.deepEqual(settings.read(),settings.read(),'重复读取不随机、不改迁移结果');
});
test('旧全局草稿不冒充新聊天，但保留旧草稿和归档兼容性', () => {
  let variables: Record<string,unknown> = {};
  const settings = new ScriptWorkbenchSettings({getScriptVariables:()=>variables,replaceScriptVariables:next=>{variables=next;}});
  const draft=input(); delete draft.creativeReferences;
  settings.update({ruinDraft:draft});
  assert.equal(settings.getRuinDraft({characterKey:'另一张卡',chatId:'新聊天'}),null);
  assert.deepEqual(settings.read().ruinDraft,draft);
});
test('生产页面保留五个顶层入口、三个子页，移动端子页可见且不重挂控制台', () => {
  const ui=readFileSync(new URL('../src/ui/ruinWorkbench.ts',import.meta.url),'utf8');
  const shell=readFileSync(new URL('../src/ui/workbenchShell.ts',import.meta.url),'utf8');
  const css=readFileSync(new URL('../src/ui/creativeWorkbench.css',import.meta.url),'utf8');
  assert.match(ui,/RUIN_PANELS = \['generation', 'tasks', 'butterfly'\]/u);
  assert.match(ui,/data-butterfly-panel/u); assert.match(ui,/确认|selectPanel/u);
  assert.match(shell,/data-ruin-child/u); assert.match(shell,/butterfly-references/u);
  assert.match(css,/@media\(min-width:1001px\).*embedded-subtabs/u);
  assert.match(css,/--sans:var\(--font-ui/u);
  assert.match(css,/\.ruin-app \.field select.*border-radius:var\(--archive-radius-control,9px\)/u);
  assert.match(css,/\.butterfly-console \{[^\n]*border-radius:var\(--archive-radius-panel,18px\)/u);
  assert.match(ui,/state\.panel === 'butterfly'.*hidden === false.*return/u);
});

test('唯一新遣返按钮位于蝴蝶控制台，时空页退役旧入口，输入后须重新确认', () => {
  const console = readFileSync(new URL('../src/ui/butterflyWorkbench.ts',import.meta.url),'utf8');
  const timeline = readFileSync(new URL('../src/ui/timelineWorkbench.ts',import.meta.url),'utf8');
  assert.match(console,/data-return.*!confirmed \|\| saving \|\| returning/u);
  assert.match(console,/遣返现世/u);
  assert.match(console,/referenceRevision === capturedReferenceRevision && !editing/u);
  assert.doesNotMatch(timeline,/data-return|client\.returnRuin\(/u);
  assert.match(timeline,/墟境探索 → 蝴蝶效应/u);
});
