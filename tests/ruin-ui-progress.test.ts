import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('墟境大纲后自动扩写全部候选，界面只为失败项保留手动重试', async () => {
  const [workflow, workbench, css] = await Promise.all([
    readFile(new URL('../src/workflows/ruin.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/ruinWorkbench.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/ui/ruinWorkbench.css', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /for \(const candidate of result\.candidates\)[\s\S]*await this\.expandCandidate/u);
  assert.match(workbench, /status === 'generating'/u);
  assert.match(workbench, /正在自动扩写这份墟境史稿/u);
  assert.match(workbench, /class="dossier-spinner"/u);
  assert.match(workbench, /aria-busy="true"/u);
  assert.doesNotMatch(workbench, />生成此墟境史稿</u);
  assert.match(workbench, />重新生成此墟境</u);
  assert.match(css, /\.dossier-spinner[\s\S]*animation: turn/u);
  assert.match(workbench, /data-record-selector/u);
  assert.match(workbench, /切换已生成的墟境任务/u);
  assert.match(workbench, /增量同步只更新资料，不夺走用户当前正在阅读的旧记录/u);
  assert.match(workbench, /data-candidate-tab-id=/u);
  assert.match(
    workbench,
    /querySelectorAll<HTMLButtonElement>\('\[data-candidate-tab-id\]'\)/u,
    '候选页签必须使用专属选择器，不能误命中节点或进入按钮',
  );
  assert.doesNotMatch(
    workbench,
    /querySelectorAll<HTMLButtonElement>\('\[data-candidate-id\]'\)/u,
    '通用 candidate-id 监听器会在点击进入按钮时清空 selectedNodeId',
  );
  assert.doesNotMatch(
    workbench,
    /if \(state\.busy\)[\s\S]{0,700}state\.activeRecordKey = generatingRecord\.key/u,
  );
  assert.doesNotMatch(
    workbench,
    /node\.kind === 'anomaly' \? 'anomaly'/u,
    '高潮只是阶段名，不应再拥有排他性节点配色',
  );
  assert.doesNotMatch(css, /\.history-node\.anomaly/u);
  assert.doesNotMatch(css, /\.timeline-event\.anomaly/u);
  assert.match(css, /\.history-node\.selected[\s\S]*border-color: var\(--teal\)/u);
  assert.match(css, /\.timeline-event\.selected::after[\s\S]*background: var\(--teal\)/u);
  assert.match(
    css,
    /\.chronology-viewport\s*\{[\s\S]*?height:\s*auto;[\s\S]*?overflow-y:\s*hidden;/u,
    '编辑部节点条必须清除旧时间轴的固定视口高度',
  );
  assert.match(
    css,
    /\.chronology-track\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*112px;/u,
    '四阶段轨道应以紧凑内容高度呈现',
  );
  assert.match(
    css,
    /\.timeline-event\s*\{[\s\S]*?top:\s*auto;[\s\S]*?margin:\s*0;/u,
    '编辑部节点不得继承旧泳道偏移与外边距',
  );
  assert.match(css, /\.timeline-event::after\s*\{\s*display:\s*none;/u);
  assert.match(css, /\.history-node\.selected\s*\{\s*box-shadow:\s*none;/u);
  assert.match(
    workbench,
    /flowState !== 'exploring' && state\.runtime\.flowState !== 'anchored'[\s\S]*return ''/u,
    '墟境任务模块只能在已进入墟境后出现',
  );
  assert.match(workbench, /const active = tasks\.find\(task => !task\.terminal\)/u);
  assert.match(workbench, /data-create-ruin-task/u);
  assert.match(workbench, /拟定任务草案/u);
  assert.match(workbench, /data-task-interpretation/u);
  assert.match(workbench, /data-task-scale/u);
  assert.match(workbench, /data-confirm-ruin-task/u);
  assert.match(workbench, /已封缄/u);
  assert.match(workbench, /ruin-task-card \$\{active \? 'is-active' : 'is-terminal'\}/u);
  assert.match(css, /\.ruin-task-section/u);
  assert.match(css, /\.ruin-task-card\.is-terminal/u);
});
