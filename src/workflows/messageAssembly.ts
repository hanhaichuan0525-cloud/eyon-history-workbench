export interface MessageAssemblyResult {
  content: string;
  warning: 'none' | 'slot_missing' | 'court_missing' | 'trailing_discarded';
}

const ROOT_TRACE_BLOCK = /\[RootTrace\][\s\S]*?\[\/RootTrace\]/gu;
const ROOT_TRACE_SLOT = /\[EYON_ROOTTRACE_SLOT::[^\]\r\n]+\]/gu;

const RUIN_TRACE_BLOCK = /\[(?:RuinTrace|RuinTeance)\][\s\S]*?\[\/(?:RuinTrace|RuinTeance)\]/gu;
const MVU_PANEL = '<UpdateVariable>';

/**
 * 把权威 [RuinTrace] 块组装进穿越助手楼(与 insertRootTrace 同款模式):
 * - 主路径:替换模型自发输出的 [RuinTrace]/[RuinTeance] 块(容错拼写);
 *   多个自发块只保留第一个(替换为权威块),其余删除。
 * - 兜底 1:文末 MVU 变量面板(<UpdateVariable>)之前插入,保持「正文 → 面板」顺序。
 * - 兜底 2:末尾追加。
 * 展示层压成单行:墟境美化正则(markdownOnly)只认字段间的空格,
 * 不认换行渲染后的 <br>;字段值内部的换行仍在捕获组内,不受影响。
 */
export function insertRuinTrace(message: string, trace: string): string {
  const flatTrace = trace.replace(/\n/g, ' ');

  if (RUIN_TRACE_BLOCK.test(message)) {
    RUIN_TRACE_BLOCK.lastIndex = 0;
    let inserted = false;
    const content = message.replace(RUIN_TRACE_BLOCK, () => {
      if (inserted) return '';
      inserted = true;
      return flatTrace;
    });
    RUIN_TRACE_BLOCK.lastIndex = 0;
    return content;
  }
  RUIN_TRACE_BLOCK.lastIndex = 0;

  const panelIndex = message.indexOf(MVU_PANEL);
  if (panelIndex >= 0) {
    const head = message.slice(0, panelIndex).trimEnd();
    const tail = message.slice(panelIndex);
    return `${head}\n${flatTrace}\n${tail}`;
  }

  return `${message.trimEnd()}\n${flatTrace}`;
}

export function insertRootTrace(
  message: string,
  slot: string,
  rootTrace: string,
): MessageAssemblyResult {
  const sanitizedMessage = message.replace(ROOT_TRACE_SLOT, '');
  // 展示层压成单行：传记美化正则（markdownOnly）只认字段间的空格，不认换行渲染后的 <br>。
  // 正文里的换行早已被 escapeHtml 转成 &#10;（字面文本），此替换只命中字段之间的真实换行。
  const flatRootTrace = rootTrace.replace(/\n/g, ' ');

  // 主路径：正文模型只输出伊雍开场 + <eyon_court/>，脚本在 court 后主动插入 RootTrace。
  // 用 lastIndexOf 找「最后一个」court；按楼层契约（伊雍开场 + <eyon_court/> + RootTrace），
  // court 之后本不应有正文模型内容。但流式生成里模型常在 court 后又输出：
  //   - 伊雍对白的自然收尾/延续（正当正文）；
  //   - 每楼文末的 `<UpdateVariable>` MVU 面板（`<Analysis>`+`<JSONPatch>`，被美化渲染成面板）。
  // 这些是合法内容，**不得按照长度一刀切丢弃**（历史 bug：把 court 后一切当假传记吞掉）。
  // 组装顺序（方案 A）：court 前正文 → <eyon_court/> → 权威 RootTrace → court 后正文与面板。
  // 只剥离一种真异常：模型模仿旧楼残留的 [RootTrace]...[/RootTrace] 无美化假传记块。
  const court = '<eyon_court/>';
  const courtIndex = sanitizedMessage.lastIndexOf(court);
  if (courtIndex >= 0) {
    const insertionPoint = courtIndex + court.length;
    const head = sanitizedMessage.slice(0, insertionPoint).trimEnd();
    const tailSource = sanitizedMessage.slice(insertionPoint);
    const fakeBlockRemoved = ROOT_TRACE_BLOCK.test(tailSource);
    ROOT_TRACE_BLOCK.lastIndex = 0;
    const tail = tailSource.replace(ROOT_TRACE_BLOCK, '').trim();
    ROOT_TRACE_BLOCK.lastIndex = 0;
    return {
      content: `${head}\n${flatRootTrace}${tail ? `\n${tail}` : ''}`,
      warning: fakeBlockRemoved ? 'trailing_discarded' : 'none',
    };
  }

  // 兜底 1：旧正文复述了本次请求槽，原位替换。
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
          return flatRootTrace + part;
        }
        return part;
      })
      .join('')
      .replace(ROOT_TRACE_SLOT, '');
    return { content, warning: 'none' };
  }

  // 兜底 2：模型自行生成了 [RootTrace]，原位替换。
  if (ROOT_TRACE_BLOCK.test(sanitizedMessage)) {
    ROOT_TRACE_BLOCK.lastIndex = 0;
    let inserted = false;
    const content = sanitizedMessage.replace(ROOT_TRACE_BLOCK, () => {
      if (inserted) {
        return '';
      }
      inserted = true;
      return flatRootTrace;
    });
    return { content, warning: 'slot_missing' };
  }
  ROOT_TRACE_BLOCK.lastIndex = 0;

  // 兜底 3：连 <eyon_court/> 都没有，末尾追加。
  return {
    content: `${sanitizedMessage.trimEnd()}\n${flatRootTrace}`,
    warning: 'court_missing',
  };
}
