export interface MessageAssemblyResult {
  content: string;
  warning: 'none' | 'slot_missing' | 'court_missing';
}

const ROOT_TRACE_BLOCK = /\[RootTrace\][\s\S]*?\[\/RootTrace\]/gu;

export function insertRootTrace(
  message: string,
  slot: string,
  rootTrace: string,
): MessageAssemblyResult {
  const slotCount = message.split(slot).length - 1;
  if (slotCount > 0) {
    let inserted = false;
    const content = message
      .split(slot)
      .map((part, index) => {
        if (index === 0) {
          return part;
        }
        if (!inserted) {
          inserted = true;
          return rootTrace + part;
        }
        return part;
      })
      .join('');
    return { content, warning: 'none' };
  }

  if (ROOT_TRACE_BLOCK.test(message)) {
    ROOT_TRACE_BLOCK.lastIndex = 0;
    let inserted = false;
    const content = message.replace(ROOT_TRACE_BLOCK, () => {
      if (inserted) {
        return '';
      }
      inserted = true;
      return rootTrace;
    });
    return { content, warning: 'slot_missing' };
  }
  ROOT_TRACE_BLOCK.lastIndex = 0;

  const court = '<eyon_court/>';
  const courtIndex = message.lastIndexOf(court);
  if (courtIndex >= 0) {
    const insertionPoint = courtIndex + court.length;
    return {
      content: `${message.slice(0, insertionPoint)}\n${rootTrace}${message.slice(insertionPoint)}`,
      warning: 'slot_missing',
    };
  }

  return {
    content: `${message.trimEnd()}\n${rootTrace}`,
    warning: 'court_missing',
  };
}
