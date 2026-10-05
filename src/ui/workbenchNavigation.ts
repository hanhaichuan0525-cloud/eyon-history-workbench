export const WORKBENCH_VIEW_IDS = [
  'timeline',
  'genealogy',
  'ruin',
  'biography',
  'settings',
] as const;

export type WorkbenchViewId = typeof WORKBENCH_VIEW_IDS[number];

export interface WorkbenchViewDefinition {
  id: WorkbenchViewId;
  label: string;
  shortLabel: string;
  icon: string;
  kicker: string;
  context: string;
  title: string;
  subtitle: string;
}

export const WORKBENCH_VIEWS: WorkbenchViewDefinition[] = [
  {
    id: 'timeline',
    label: '历史长河',
    shortLabel: '长河',
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 6h14M5 12h9M5 18h12"/><circle cx="18" cy="12" r="2.5"/></svg>',
    kicker: 'HISTORICAL CURRENT',
    context: '现实锚点与墟境时空',
    title: '历史长河',
    subtitle: '核对现实锚点、当前墟境进程与已经归档的蝴蝶效应；历史在这里呈现为可追溯的运行状态。',
  },
  {
    id: 'genealogy',
    label: '宗族谱系',
    shortLabel: '谱系',
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M12 7.5v4M6 15.5v-4h12v4"/></svg>',
    kicker: 'GENEALOGY ARCHIVE',
    context: '血脉、亲缘与世代脉络',
    title: '宗族谱系',
    subtitle: '按祖辈与后代代数整理已确认亲属，让谱系成为传记与墟境能够共同读取的历史底稿。',
  },
  {
    id: 'ruin',
    label: '墟境探索',
    shortLabel: '探索',
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19h14M7 19V9l5-4 5 4v10M9.5 19v-6h5v6M4 9h16"/></svg>',
    kicker: 'RUIN EXPEDITION',
    context: '历史候选与四阶段入口',
    title: '墟境探索',
    subtitle: '从史料、人物与地点中推演可进入的历史现场，并沿缘起、经过、高潮与结果选择落点。',
  },
  {
    id: 'biography',
    label: '传记书库',
    shortLabel: '传记',
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4.5 5.5A3.5 3.5 0 0 1 8 2h11.5v17H8a3.5 3.5 0 0 0-3.5 3V5.5Z"/><path d="M8 2v17M11 7h5M11 11h5"/></svg>',
    kicker: 'SERPENT BIOGRAPHY',
    context: '王庭典籍与全文阅览',
    title: '传记书库',
    subtitle: '按卷册收存起源、历史阶段与现世续章，并让完整传记参与谱系与墟境检索。',
  },
  {
    id: 'settings',
    label: '工作台设置',
    shortLabel: '设置',
    icon: '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19 13.5v-3l-2.1-.6a7.6 7.6 0 0 0-.7-1.7l1.1-1.9-2.1-2.1-1.9 1.1a7.6 7.6 0 0 0-1.7-.7L11 2.5H8l-.6 2.1a7.6 7.6 0 0 0-1.7.7L3.8 4.2 1.7 6.3l1.1 1.9a7.6 7.6 0 0 0-.7 1.7L0 10.5v3l2.1.6c.2.6.4 1.2.7 1.7l-1.1 1.9 2.1 2.1 1.9-1.1c.5.3 1.1.5 1.7.7l.6 2.1h3l.6-2.1c.6-.2 1.2-.4 1.7-.7l1.9 1.1 2.1-2.1-1.1-1.9c.3-.5.5-1.1.7-1.7l2.1-.6Z" transform="translate(2 0) scale(.82)"/></svg>',
    kicker: 'SCRIPTORIUM SETTINGS',
    context: '生成、外观与资料边界',
    title: '工作台设置',
    subtitle: '管理各生成模块的 API 路由、王庭外观与当前聊天能够读取的资料范围。',
  },
];

export function normalizeWorkbenchView(value: string): WorkbenchViewId {
  return WORKBENCH_VIEW_IDS.includes(value as WorkbenchViewId)
    ? value as WorkbenchViewId
    : 'timeline';
}
