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
  {
    type: 'genealogy.generate',
    pattern: /^(?:请)?(?:宗族谱系|(?:对|为).{1,80}?(?:生成|整理|建立)(?:一份)?宗族谱系)(?:[\s，,：:]|$)/u,
  },
  {
    type: 'ruin.generate',
    pattern: /^(?:请)?墟境探索(?:[\s，,：:]|$)/u,
  },
  {
    type: 'ruin.enter',
    pattern: /^(?:请)?进入节点(?:[\s，,：:]|$)/u,
  },
  {
    type: 'ruin.return',
    pattern: /^(?:请)?(?:遣返|返回现世|回到现实|结算蝴蝶效应)(?:[\s，,。.!！：:]|$)/u,
  },
];

function normalizeInput(input: string): string {
  return input.normalize('NFKC').replace(/\r\n?/gu, '\n').trim();
}

export function parseTextCommand(input: string): WorkbenchCommand | null {
  const raw = normalizeInput(input);
  if (!raw) {
    return null;
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
