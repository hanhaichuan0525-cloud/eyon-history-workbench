import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_BUTTERFLY_REFERENCES, BUTTERFLY_OPTIONS, BUTTERFLY_PRESETS, RUIN_STYLE_OPTIONS, ButterflyReferencesSchema, createReferencedRuinMaterials, defaultRuinReferences, randomButterflyReferences, randomRuinReferences, renderButterflyReferences, renderRuinCreativeReferences, absurdityLabel, ruinStyleMeaning } from '../src/core/creativeReferences.ts';
import { readRuinGeography, geographyPathsFromText } from '../src/core/ruinGeography.ts';
import { ScriptWorkbenchSettings } from '../src/runtime/workbenchSettings.ts';
import { RuinGenerationInputSchema } from '../src/schemas/ruin.ts';

function input() {
  const refs = { ...defaultRuinReferences(), periods: ['stable', 'stable', 'stable'] as const };
  return RuinGenerationInputSchema.parse({ era: '复兴纪元', start: null, end: null, location: '亚尔夫海姆-幽谷-溪畔', supplementaryDirection: '二叶幼年玩积木', selectedCharacters: [], wave: { level: 'ripple', candidateCount: 3 }, materials: createReferencedRuinMaterials(3, { ...refs, periods: [...refs.periods] }), creativeReferences: refs });
}

test('离奇、传奇与信仰所有组合遵循通用未来演化机制，尺度仍独立', () => {
  for (const absurdity of [0, 21, 41, 61, 100]) {
    for (const legend of BUTTERFLY_OPTIONS.legend) {
      for (const domain of BUTTERFLY_OPTIONS.domain) {
        const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES,
          absurdity, legend, domain });
        assert.doesNotMatch(prompt, /世界神系与自然条件仍成立|社会信仰变化不改神明本体/u);
        assert.match(prompt, /低荒诞也可影响国家，高荒诞也可只改变一个人/u);
        if (domain === '信仰与文化') {
          assert.match(prompt, /依世界机制改变真实身份、力量、关系和历史地位/u);
          assert.match(prompt, /旧有重要对象不因地位高就自动免于未来分岔/u);
          assert.doesNotMatch(prompt, /不等于改写神明本体/u);
        }
      }
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
test('每个文风选项都有语义解释，不作为事件或结局的强制条件', () => {
  for (const key of ['telling', 'pace', 'mood'] as const) for (const option of RUIN_STYLE_OPTIONS[key]) {
    const draft = input(); draft.creativeReferences![key] = option as never;
    const prompt = renderRuinCreativeReferences(draft);
    assert.ok(prompt.includes(option)); assert.doesNotMatch(prompt, /undefined/u);
    assert.ok(ruinStyleMeaning(key, option).length >= 120, `${key}/${option} 要说明写法和适用边界，不只提供标签`);
  }
  const draft = input(); Object.assign(draft.creativeReferences!, { telling: '多方讲述', pace: '起伏鲜明', mood: '悲伤惋惜' });
  assert.match(renderRuinCreativeReferences(draft), /玩积木也可.*搭成、倒塌/u);
  assert.match(renderRuinCreativeReferences(draft), /不强制死亡/u);
  Object.assign(draft.creativeReferences!, { telling: '逐步揭示', pace: '舒缓描写', mood: '甜蜜暧昧' });
  assert.match(renderRuinCreativeReferences(draft), /不能为每位士兵新配恋人/u);
  assert.match(renderRuinCreativeReferences(draft), /已知结局保持准确.*不把已知事实伪装/u);
  assert.notEqual(ruinStyleMeaning('telling', '随内容自动'), ruinStyleMeaning('pace', '随内容自动'));
  assert.match(renderRuinCreativeReferences(draft), /不因未满足偏好重试、报错或截断正文/u);
  const definitions = Object.entries(RUIN_STYLE_OPTIONS).flatMap(([group, options]) => options.map(option => ruinStyleMeaning(group as keyof typeof RUIN_STYLE_OPTIONS, option)));
  assert.equal(new Set(definitions).size, definitions.length, '每项包括自动选项都使用自己的语义，不复用套话');
  assert.ok(definitions.every(text => !text.includes('二叶')), '通用文风示例不向其他题材注入具体角色');
});
test('全部23项讲述气质都有独立写作抓手，只投递选项且不新增评分或输出结构', () => {
  const definitions: string[] = [];
  for (const group of ['telling', 'pace', 'mood'] as const) {
    for (const option of RUIN_STYLE_OPTIONS[group]) {
      const meaning = ruinStyleMeaning(group, option);
      const craft = meaning.split('写作抓手：')[1];
      assert.ok(craft && craft.length >= 100, `${group}/${option}要有实际场面和语言操作`);
      definitions.push(craft);
      const draft = input(); draft.creativeReferences![group] = option as never;
      assert.ok(renderRuinCreativeReferences(draft).includes(craft));
    }
  }
  assert.equal(definitions.length, 23);
  assert.equal(new Set(definitions).size, 23);
  const draft = input(); Object.assign(draft.creativeReferences!, { telling: '现场展开', pace: '舒缓描写', mood: '冷静克制' });
  const prompt = renderRuinCreativeReferences(draft);
  assert.match(prompt, /写作抓手/u);
  for (const unused of ['多方讲述', '回忆讲述', '起伏鲜明', '热烈昂扬']) assert.ok(!prompt.includes(`「${unused}」`));
  assert.match(prompt, /不因未满足偏好重试、报错或截断正文/u);
});

test('九项蝴蝶偏好不预设结局，不让感知窗口绑架历史范围或归返锚点', () => {
  const text = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: 100, legend: '史诗回响', focus: '玩家的孩子' });
  assert.match(text, /极诞/u);
  assert.match(text, /守住已发生事实与世界运行机制，受分歧影响的未来可大胆改变/u);
  assert.doesNotMatch(text, /既成行动、世界神系与自然条件仍成立/u);
  assert.match(text, /圣人、工程师或平凡的人/u); assert.match(text, /不能预定封圣/u);
  assert.match(text, /三件事/u); assert.match(text, /不要求当场/u);
  assert.equal(Object.keys(DEFAULT_BUTTERFLY_REFERENCES).length, 9);
  assert.ok(BUTTERFLY_PRESETS.length >= 3);
  assert.doesNotMatch(text, /undefined/u);
});

test('蝴蝶每项选项含独立展开语义，五档力度只投递当前一档', () => {
  for (const [group, options] of Object.entries(BUTTERFLY_OPTIONS)) {
    const label = { scope: '波及范围', domain: '影响领域', intensity: '改写力度', legend: '传奇感',
      evolution: '演化方式', mood: '情绪底色', manifestation: '显现方式' }[group]!;
    const definitions = options.map(option => {
      const text = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, [group]: option });
      const line = text.split('\n\n').find(line => line.startsWith(`${label}「${option}」`))!;
      assert.ok(line && line.length >= 75, `${group}/${option}须有具体写法而非只贴标签`);
      assert.doesNotMatch(line, /undefined/u);
      return line.split('：').slice(1).join('：');
    });
    assert.equal(new Set(definitions).size, options.length);
  }
  for (const intensity of BUTTERFLY_OPTIONS.intensity) {
    const line = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, intensity })
      .split('\n\n').find(line => line.startsWith('改写力度'))!;
    for (const other of BUTTERFLY_OPTIONS.intensity.filter(value => value !== intensity)) assert.ok(!line.includes(other));
  }
  for (const [value, label] of [[0,'朴素'],[20,'朴素'],[21,'意外'],[40,'意外'],[41,'奇诡'],[60,'奇诡'],[61,'狂想'],[80,'狂想'],[81,'极诞'],[100,'极诞']] as const) {
    const line = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, absurdity: value })
      .split('\n\n').find(line => line.startsWith('荒诞值'))!;
    assert.ok(line.includes(`「${label}」`) && line.length >= 100, '去重精简后仍须有完整语义，不能只投递档位标签');
  }
});
test('蝴蝶全部离散选项及五档荒诞有独立演化抓手，关注对象不变成演员锁或结局', () => {
  const crafts: string[] = [];
  for (const [group, options] of Object.entries(BUTTERFLY_OPTIONS)) for (const option of options) {
    const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, [group]: option });
    const label = { scope: '波及范围', domain: '影响领域', intensity: '改写力度', legend: '传奇感',
      evolution: '演化方式', mood: '情绪底色', manifestation: '显现方式' }[group]!;
    const line = prompt.split('\n\n').find(line => line.startsWith(`${label}「${option}」`))!;
    const craft = line?.split('演化抓手：')[1];
    assert.ok(craft && craft.length >= 80, `${group}/${option}要说明人物承接、条件和表现`);
    crafts.push(craft);
  }
  assert.equal(new Set(crafts).size, crafts.length, '同名自动选择在不同组也使用独立含义');
  for (const absurdity of [0, 21, 41, 61, 81]) {
    const line = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, absurdity }).split('\n\n').find(line => line.startsWith('荒诞值'))!;
    assert.ok((line.split('演化抓手：')[1]?.length ?? 0) >= 80);
  }
  const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, focus: '后来捡到笔记的人', scope: '国家', evolution: '意外转用' });
  assert.match(prompt, /关注对象.*观察重心.*演化抓手/u);
  assert.match(prompt, /不是参与者名单或期望结局/u);
  assert.match(prompt, /不因文风不符返工或报错/u);
  for (const unselected of ['曲折扩散', '多线汇合', '代际接力']) assert.ok(!prompt.includes(`演化方式「${unselected}」`));
});

test('随机仅在显式调用时发生，值有界，默认对象不被突变', () => {
  const before = JSON.stringify(DEFAULT_BUTTERFLY_REFERENCES);
  for (const value of [-1, 0, 1, NaN, Infinity]) {
    assert.doesNotThrow(() => ButterflyReferencesSchema.parse(randomButterflyReferences(() => value)));
    assert.equal(randomRuinReferences(5, () => value).periods.length, 5);
  }
  assert.equal(JSON.stringify(DEFAULT_BUTTERFLY_REFERENCES), before);
  assert.deepEqual([0,20,21,40,41,60,61,80,81,100].map(absurdityLabel), ['朴素','朴素','意外','意外','奇诡','奇诡','狂想','狂想','极诞','极诞']);
});

test('48选项展开构思取舍与独立表现，而非一笔带过或全库投递', () => {
  for (const [group, options] of Object.entries(BUTTERFLY_OPTIONS)) for (const option of options) {
    const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, [group]: option });
    const label = { scope: '波及范围', domain: '影响领域', intensity: '改写力度', legend: '传奇感',
      evolution: '演化方式', mood: '情绪底色', manifestation: '显现方式' }[group]!;
    const line = prompt.split('\n\n').find(line => line.startsWith(`${label}「${option}」`))!;
    assert.ok(line.split('演化抓手：')[1].length >= 140, `${group}/${option}需展开具体取舍与表现`);
    for (const other of options.filter(other => other !== option)) assert.ok(!prompt.includes(`${label}「${other}」`));
  }
  const refs = { ...DEFAULT_BUTTERFLY_REFERENCES, scope: '大陆' as const, domain: '人物命运' as const,
    intensity: '时代回响' as const, absurdity: 100, legend: '史诗回响' as const, evolution: '代际接力' as const };
  const prompt = renderButterflyReferences(refs);
  assert.match(prompt, /改变谁的选择.*选择怎样牵动.*历史/u);
  assert.match(prompt, /不只.*新职业|新职业.*不.*人生/u);
  assert.match(prompt, /原物.*遗忘|遗忘.*原物/u);
  assert.match(prompt, /极诞.*偏离.*直接预期/u);
  assert.match(prompt, /逻辑是故事成立的底线，不是选择最普通路线的理由/u);
  assert.match(prompt, /不因文风不符返工或报错/u);
});

test('七种显现各有感官写法，不把人物、环境与公共景观都写成记录文件', () => {
  const meanings = {
    '自然遇见': /声音.*气味/u,
    '人物与关系': /疤痕.*称呼/u,
    '生活与习俗': /味道.*动作/u,
    '器物与技术': /使用.*功能/u,
    '信仰与公共景观': /军旗.*敬礼/u,
    '传闻与作品': /讲述者.*立场/u,
    '多种线索': /互补.*不是.*重复/u,
  };
  for (const manifestation of BUTTERFLY_OPTIONS.manifestation) {
    const prompt = renderButterflyReferences({ ...DEFAULT_BUTTERFLY_REFERENCES, manifestation });
    const line = prompt.split('\n\n').find(line => line.startsWith('显现方式'))!;
    assert.match(line, meanings[manifestation]);
  }
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
