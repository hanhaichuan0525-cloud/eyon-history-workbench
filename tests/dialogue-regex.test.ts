import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const rule = JSON.parse(readFileSync(new URL('../regex/regex-伊雍-对话框美化（as）.json', import.meta.url), 'utf8'));
const moods = ['bright', 'curious', 'startled', 'shywarm', 'pouty', 'sad', 'shocked', 'onheat', 'puzzled', 'overjoyed', 'tender'];

function render(input: string): string {
  const lastSlash = rule.findRegex.lastIndexOf('/');
  return input.replace(new RegExp(rule.findRegex.slice(1, lastSlash), rule.findRegex.slice(lastSlash + 1)), rule.replaceString);
}

test('伊雍专属对话框固定显示中文名，不依赖模型的 name 属性', () => {
  for (const name of ['伊雍', 'eyon', 'Eyon', 'EYON', '']) {
    const output = render(`<eyon name="${name}" mood="curious">「主人，回来啦。」</eyon><eyon_court/>`);
    assert.deepEqual([...output.matchAll(/<h3>(.*?)<\/h3>/gu)].map(match => match[1]), ['伊雍']);
    assert.ok(output.includes('<div class="eyon-vow-body">主人，回来啦。</div>'));
  }
});

test('固定标题不改变情绪、对白原文或 eyon 技术类名', () => {
  const body = '第一行提到 eyon。\n第二行保留 <em>原文</em>。';
  for (const mood of moods) {
    const output = render(`<eyon name="eyon" mood="${mood}">「${body}」</eyon>`);
    assert.ok(output.includes(`data-mood="${mood}"`));
    assert.ok(output.includes(`<div class="eyon-vow-body">${body}</div>`));
    assert.ok(output.includes('class="eyon-avatar-img eyon-avatar-curious"'));
  }
});

test('没有 mood 的原有格式仍正常显示', () => {
  const output = render('<eyon name="eyon">「主人，eyon 是标签名。」</eyon>');
  assert.ok(output.includes('<h3>伊雍</h3>'));
  assert.ok(output.includes('data-mood=""'));
  assert.ok(output.includes('<div class="eyon-vow-body">主人，eyon 是标签名。</div>'));
});

test('同一楼多段对白分别替换，其他角色与框外正文不被更名', () => {
  const before = '框外 eyon\n<other name="eyon">「其他角色」</other>\n';
  const output = render(before + '<eyon name="eyon" mood="sad">「甲」</eyon>\n<eyon name="伊雍" mood="bright">「乙」</eyon>');
  assert.ok(output.startsWith(before));
  assert.deepEqual([...output.matchAll(/<h3>(.*?)<\/h3>/gu)].map(match => match[1]), ['伊雍', '伊雍']);
  assert.ok(output.includes('data-mood="sad"'));
  assert.ok(output.includes('data-mood="bright"'));
  assert.ok(output.includes('<div class="eyon-vow-body">甲</div>'));
  assert.ok(output.includes('<div class="eyon-vow-body">乙</div>'));
});

test('对话正则仍使用原 ID、显示目标与楼层范围', () => {
  assert.equal(rule.id, '3364f9e2-a813-465a-91d5-d2d3cd1d052d');
  assert.equal(rule.disabled, false);
  assert.deepEqual(rule.placement, [2]);
  assert.equal(rule.markdownOnly, true);
  assert.equal(rule.promptOnly, false);
  assert.equal(rule.runOnEdit, true);
  assert.equal(rule.substituteRegex, 0);
  assert.equal(rule.minDepth, null);
  assert.equal(rule.maxDepth, 8);
  assert.deepEqual(rule.trimStrings, []);
});
