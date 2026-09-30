import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampCompanionInViewport,
  clampCompanionPosition,
  collectHostFrames,
  companionPresentation,
  companionViewportRect,
  isWorkbenchVisible,
} from '../src/ui/companionPresentation.ts';

test('伴生入口按任务状态选择役情动作与文案', () => {
  assert.deepEqual(companionPresentation({
    status: 'assembling_context',
    detail: '正在查找史料',
    taskType: 'biography',
    phase: 'running',
  }), {
    title: '我去书架上找那一卷……',
    motion: 'biography',
    state: 'working',
  });
  assert.equal(companionPresentation({
    status: 'entering_ruin',
    detail: '时光之门已然洞开，正在等待正文',
    taskType: 'ruin',
    phase: 'running',
  }).motion, 'ruin-portal');
  assert.equal(companionPresentation({
    status: 'failed',
    detail: '境界生成未完成',
    taskType: 'ruin',
    phase: 'error',
  }).title, '本次处理未完成');
});

test('伴生入口坐标始终被限制在视口中', () => {
  assert.deepEqual(clampCompanionPosition(-100, -20, 800, 600), { left: 8, top: 8 });
  assert.deepEqual(clampCompanionPosition(900, 700, 800, 600), { left: 736, top: 536 });
  assert.deepEqual(clampCompanionPosition(120, 220, 800, 600), { left: 120, top: 220 });
});

test('工作台打开反馈区分正在展开与已经可见', () => {
  const presentation = (status: string) => companionPresentation({
    status, detail: '', taskType: 'system', phase: 'info',
  }).title;
  assert.equal(presentation('workbench_opening'), '正在为主人展开工作台……');
  assert.equal(presentation('workbench_open'), '工作台为主人展开了');
});

function visibilityFixture() {
  const element = () => ({
    isConnected: true,
    hidden: false,
    style: { display: 'block', visibility: 'visible', opacity: '1' },
    rect: { width: 375, height: 720, left: 0, top: 0, right: 375, bottom: 720 },
    hasAttribute(name: string) { return name === 'hidden' && this.hidden; },
    getBoundingClientRect() { return this.rect; },
  });
  const overlay = element();
  const app = element();
  const host = { ...element(), shadowRoot: { querySelector: () => app } };
  const shell = { ...element(), firstElementChild: host, closest: () => overlay };
  const frame = {
    innerWidth: 375, innerHeight: 720,
    document: { querySelector: () => shell },
    getComputedStyle: (node: ReturnType<typeof element>) => node.style,
  };
  return { overlay, shell, host, app, frame: frame as unknown as Window };
}

test('工作台可见性：存在全局外壳但弹层高度为零，不能声称打开成功', () => {
  const fixture = visibilityFixture();
  assert.equal(isWorkbenchVisible(fixture.frame), true);
  fixture.overlay.rect.height = 0;
  fixture.overlay.rect.bottom = 0;
  assert.equal(isWorkbenchVisible(fixture.frame), false);
});

test('工作台可见性：隐藏、脱离文档、零尺寸或移出视口都返回未打开', () => {
  const fixture = visibilityFixture();
  fixture.overlay.hidden = true;
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  fixture.overlay.hidden = false;
  fixture.host.isConnected = false;
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  fixture.host.isConnected = true;
  fixture.app.style.visibility = 'hidden';
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  fixture.app.style.visibility = 'visible';
  fixture.app.style.opacity = '0';
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  fixture.app.style.opacity = '1';
  fixture.app.rect.left = 400;
  assert.equal(isWorkbenchVisible(fixture.frame), false);
});

test('工作台可见性：还没有渲染 .app 或跨域拒绝读取时返回未打开', () => {
  const fixture = visibilityFixture();
  Object.assign(fixture.host, { shadowRoot: null });
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  Object.defineProperty(fixture.frame, 'document', { get() { throw new Error('cross-origin'); } });
  assert.equal(isWorkbenchVisible(fixture.frame), false);
  assert.equal(isWorkbenchVisible(null), false);
});

/**
 * β1.2 真机病历：手机上悬浮球跑出界面且拖不动——夹取用的是布局视口
 * （innerWidth/innerHeight），而手机可视视口更小；且只在 window.resize 重夹。
 * 这里锁死真王式的可视视口口径。
 */
test('悬浮球视口口径：优先 visualViewport，回退 innerWidth/innerHeight，非法值返回 null', () => {
  assert.deepEqual(
    companionViewportRect({
      visualViewport: { width: 390, height: 664, offsetLeft: 0, offsetTop: 60 },
      innerWidth: 390,
      innerHeight: 844,
    }),
    { width: 390, height: 664, left: 0, top: 60 },
    '缩放/地址栏导致可视视口更小时必须用可视视口',
  );
  assert.deepEqual(
    companionViewportRect({ visualViewport: null, innerWidth: 1280, innerHeight: 720 }),
    { width: 1280, height: 720, left: 0, top: 0 },
    '没有 visualViewport 时回退布局视口',
  );
  assert.equal(companionViewportRect({ visualViewport: { width: 0, height: 0 }, innerWidth: 0, innerHeight: 0 }), null);
  assert.equal(companionViewportRect(null), null);
});

test('可视视口夹取：计入偏移、margin 自适应，视口再小也不会把球挤出去', () => {
  const viewport = { width: 390, height: 664, left: 0, top: 60 };
  // 越界 → 夹回可视区内（下边界 = top + height - size - margin）
  assert.deepEqual(clampCompanionInViewport(9999, 9999, viewport, 56, 8), { left: 326, top: 660 });
  assert.deepEqual(clampCompanionInViewport(-50, -50, viewport, 56, 8), { left: 8, top: 68 });
  // 视口比球还小：margin 收缩到 space/2，结果仍在视口内
  const tiny = { width: 40, height: 40, left: 0, top: 0 };
  assert.deepEqual(clampCompanionInViewport(500, 500, tiny, 56, 8), { left: 0, top: 0 });
});

/**
 * β1.3 真机病历：手机上工作台打不开——悬浮球挂在顶层窗口，而脚本加载器只上溯一层，
 * 两者在手机上不是同一个窗口，`:open` 事件没人收。这里锁死跨窗口收集逻辑。
 */
test('跨窗口查找：收集自己 + 祖先 + 后代 frame，去重防环且跨域不炸', () => {
  type Frame = { parent?: Frame | null; frames?: Frame[] };
  const top: Frame = { parent: null, frames: [] };
  const loaderFrame: Frame = { parent: top, frames: [] };
  const scriptFrame: Frame = { parent: loaderFrame, frames: [] };
  top.frames = [loaderFrame];
  loaderFrame.frames = [scriptFrame];

  assert.deepEqual(
    collectHostFrames(scriptFrame),
    [scriptFrame, loaderFrame, top],
    '从深层 frame 出发应能拿到祖先链',
  );
  assert.deepEqual(
    collectHostFrames(top),
    [top, loaderFrame, scriptFrame],
    '从顶层出发应能下潜到子孙 frame（加载器可能挂在这里）',
  );

  const lonely: Frame = { frames: [] };
  lonely.parent = lonely;
  assert.deepEqual(collectHostFrames(lonely), [lonely], '自环只返回自己');
  assert.deepEqual(collectHostFrames(null), []);

  const hostile: Frame = { parent: top };
  Object.defineProperty(hostile, 'frames', {
    get() {
      throw new Error('cross-origin frame');
    },
  });
  assert.deepEqual(
    collectHostFrames(hostile),
    [hostile, top, loaderFrame, scriptFrame],
    '跨域 frame 读 frames 抛错时跳过它，但祖先链仍要拿到',
  );
});
