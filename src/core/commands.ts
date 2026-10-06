export type WorkbenchCommandType =
  | 'biography.generate'
  | 'genealogy.generate'
  | 'ruin.generate'
  | 'ruin.enter'
  | 'ruin.return';

export interface WorkbenchCommand {
  type: WorkbenchCommandType;
  raw: string;
  payload: string;
  source: 'text' | 'button';
}

const TEXT_COMMANDS: ReadonlyArray<{
  type: WorkbenchCommandType;
  pattern: RegExp;
}> = [
  {
    type: 'biography.generate',
    pattern: /^(?:请)?(?:寻根溯源|(?:对|为).{1,80}?(?:进行|发起)?寻根溯源)(?:[\s，,：:]|$)/u,
  },
  // β1.1 起，墟境探索与宗族谱系**没有文本入口**。真机病历两条：
  //   ① 聊天里输入「我要墟境探索」→ 角色卡按 contains 判定以为玩家要探索，正文回一句
  //      "正在梳理历史波动"，但这里按锚定判定、根本没进生成流程 → 候选永远不会出现；
  //   ② 精确输入「墟境探索」→ 这里命中命令，可工作台草稿为空时 getInput 抛错，被
  //      fail-closed 直接掐掉整楼生成（玩家只看到自己那条消息，没有任何回复）。
  // 现在这两件事只能从工作台界面发起（墟境探查的"按历史波动生成候选"、宗族谱系面板），
  // 聊天中的任何提及都由角色卡引导玩家去工作台。
  {
    type: 'ruin.enter',
    pattern: /^(?:请)?进入节点(?:[\s，,：:]|$)/u,
  },
];

const RETURN_ACTION = String.raw`(?:遣返(?:我|我们)?(?:回去|回来|回到(?:现世|现实))?|返回(?:现世|现实)|回到(?:现世|现实)|回(?:现世|现实)|(?:送|带)(?:我|我们)回(?:现世|现实)|把(?:我|我们)(?:送|带)回(?:现世|现实)|(?:退出|离开|结束)(?:本次|这次|当前)?墟境|结算(?:本轮)?蝴蝶效应)`;
// 呼语和拖长音是指令的尾饰，不是另一个动作；问号只接受明确的礼貌请求。
const RETURN_END_PUNCTUATION = String.raw`[-—–。.!！\s]*`;
const RETURN_CLOSING = String.raw`(?:一下)?(?:吧|了|啦|即可|就好|可以了|好吗[?？]?)?${RETURN_END_PUNCTUATION}(?:(?:[，,：:]\s*)?(?:伊雍(?:公主|殿下|大人)?|公主殿下)(?:啊|呀)?${RETURN_END_PUNCTUATION})?`;
const DIRECT_RETURN_PATTERN = new RegExp(
  `^(?:请)?(?:现在|立刻|马上|直接)?${RETURN_ACTION}${RETURN_CLOSING}$`,
  'u',
);
const RETURN_SUFFIX_PATTERN = new RegExp(
  `${RETURN_ACTION}${RETURN_CLOSING}$`,
  'u',
);
const RETURN_CONNECTOR_PATTERN =
  /(?:[，,：:]|然后|随后|接着|之后|完成后|处理完后|做完后|后|再|并|现在|立刻|马上|直接|就|请|我要|我们要|我选择|我决定|我请求|可以)$/u;
const HYPOTHETICAL_RETURN_CONTEXT =
  /(?:^|[，,：:])\s*(?:如果|假如|倘若|若是|将来|未来|以后)/u;
const NEGATED_RETURN_CONTEXT =
  /(?:不要|不用|无需|不能|不会|别|暂不|暂时不|会被|被|可能|也许)(?:现在|立刻|马上|直接)?[，,：:]?$/u;
const REPORTED_RETURN_CONTEXT =
  /^(?:他|她|它|他们|她们|有人|对方|NPC).*(?:说|喊|问|要求|请求|命令)/iu;

export function normalizeCommandInput(input: string): string {
  return input.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

export function parseTextCommand(input: string): WorkbenchCommand | null {
  const raw = normalizeCommandInput(input);
  if (!raw) {
    return null;
  }

  // 保留自然遣返意愿识别，供伊雍引导与旧楼事务匹配使用。
  // 识别结果不是授权：新遣返只可由蝴蝶工作台按钮发起。
  if (isExplicitReturnIntent(raw)) {
    return {
      type: 'ruin.return',
      raw,
      payload: '',
      source: 'text',
    };
  }

  // Root trace is intentionally phrase-driven: players often wrap the command
  // in natural prose, while the other state-changing commands stay anchored.
  if (raw.includes('寻根溯源')) {
    return {
      type: 'biography.generate',
      raw,
      payload: raw,
      source: 'text',
    };
  }

  for (const command of TEXT_COMMANDS) {
    const match = command.pattern.exec(raw);
    if (!match) {
      continue;
    }

    return {
      type: command.type,
      raw,
      payload: raw.slice(match[0].length).trim(),
      source: 'text',
    };
  }

  return null;
}

export function isExplicitReturnIntent(input: string): boolean {
  const raw = stripOuterMarkdownEmphasis(normalizeCommandInput(input));
  if (!raw) return false;
  if (DIRECT_RETURN_PATTERN.test(raw)) return true;

  const action = RETURN_SUFFIX_PATTERN.exec(raw);
  if (!action || action.index <= 0) return false;
  // 换行是独立指令的句界；trimEnd 会把按钮追加的换行也删掉，
  // 导致无标点行动草稿与「遣返」被误当成同一句。
  const prefix = raw.slice(0, action.index);
  const clause = prefix.split(/[。.!！?？；;\n]/u).at(-1)?.trim() ?? '';
  // 前面是完整叙事句、末句只有指令，也属于玩家此刻的明确行动。
  if (!clause) return true;
  if (
    HYPOTHETICAL_RETURN_CONTEXT.test(clause)
    || NEGATED_RETURN_CONTEXT.test(clause)
    || REPORTED_RETURN_CONTEXT.test(clause)
  ) return false;
  return RETURN_CONNECTOR_PATTERN.test(clause);
}

function stripOuterMarkdownEmphasis(value: string): string {
  let next = value.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const marker = next.startsWith('**') && next.endsWith('**')
      ? '**'
      : next.startsWith('__') && next.endsWith('__')
        ? '__'
        : '';
    if (!marker || next.length <= marker.length * 2) break;
    next = next.slice(marker.length, -marker.length).trim();
  }
  return next;
}

export function createButtonCommand(
  type: WorkbenchCommandType,
  payload = '',
): WorkbenchCommand {
  return {
    type,
    raw: payload.trim(),
    payload: payload.trim(),
    source: 'button',
  };
}
