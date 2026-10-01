import type {
  HostAdapter,
  UserTurnAdapter,
} from '../adapters/host.ts';
import { parseTextCommand } from '../core/commands.ts';
import { namespaceKey } from '../core/namespace.ts';
import { resolveRuinEntryLocation } from '../core/ruinLocation.ts';
import { serializeRuinTrace } from '../renderers/ruinTrace.ts';
import type { RuinNode } from '../schemas/ruin.ts';
import type { TavernRuntime } from '../runtime/contracts.ts';
import {
  TavernRuinEntryShellAdapter,
  type RuinEntryFloorLock,
} from '../runtime/tavernRuinEntryShell.ts';
import { GenerationCancelledError, isTaskCancellationError } from '../runtime/tavernGeneration.ts';
import { fingerprintText } from '../runtime/transactionIdentity.ts';
import type {
  RuinCandidateRecord,
  RuinCandidateRepository,
} from '../storage/ruins.ts';
import { insertRuinTrace } from './messageAssembly.ts';
import { selectEnterableRuinNode } from './ruin.ts';

export interface RuinEntryRealityAnchor {
  time: string;
  location: string;
}

export interface RuinEntrySubmission {
  recordKey: string;
  candidateId: string;
  nodeId: string;
  /** 玩家楼 messageId */
  messageId: number;
  /** 玩家楼实际文本(决议后的玩家原话或默认语) */
  playerText: string;
  /** 注入层契约全文(【历史工作台·单楼进入契约】+ RuinTrace) */
  contractText: string;
}

export interface RuinEntryPreparedText {
  recordKey: string;
  candidateId: string;
  nodeId: string;
  /** 过渡期兼容字段:契约全文(旧 composer 路径用,随 P5 清理) */
  text: string;
}

export interface RuinEntryHooks {
  /** 宿主任务通知:status=状态词,detail=文案,extra 含 phase/progress 等通知字段 */
  onStatus?(status: string, detail: string, extra?: Record<string, unknown>): void;
}

/**
 * 空输入框进入特异点时的默认玩家语。
 * 玩家楼允许出现玩家未输入的原话(用户已拍板:空输入框允许默认语)。
 */
export const RUIN_ENTRY_DEFAULT_PHRASE = '我踏入这处历史特异点。';

/**
 * 决议进入特异点时玩家楼的实际文本(纯函数):
 * - 空 / 纯空白(含读框失败传 null)→ 默认语;
 * - 命中任一工作台命令格式 → 默认语(防御:防止 WorkbenchLifecycle.beforeGeneration
 *   把玩家楼误判为命令,如「寻根溯源」为 contains 匹配,自然语言也可能命中);
 * - 其余 → 原样 trim 返回。
 */
export function resolveRuinEntryPlayerText(text: string | null): string {
  const normalized = String(text ?? '').trim();
  if (!normalized) return RUIN_ENTRY_DEFAULT_PHRASE;
  if (parseTextCommand(normalized)) return RUIN_ENTRY_DEFAULT_PHRASE;
  return normalized;
}

/**
 * 进入特异点时模型必须在回复末尾输出的 JSON Patch 路径清单。
 * 与时间内核白名单(RUNTIME_FIELDS)同源约束:测试断言每个
 * /墟境系统/运行状态/ 路径都在白名单内,防止注入文本与内核漂移。
 */
export const RUIN_ENTRY_PATCH_FIELDS = [
  '/墟境系统/运行状态/墟境流程状态',
  '/墟境系统/运行状态/墟境任务规则锁定',
  '/墟境系统/运行状态/墟境轮次',
  '/墟境系统/运行状态/本轮现实时间',
  '/墟境系统/运行状态/本轮现实地点',
  '/墟境系统/运行状态/墟境当前时间',
  '/墟境系统/运行状态/墟境当前地点',
  '/墟境系统/运行状态/本轮墟境进入时间',
  '/墟境系统/运行状态/本轮墟境进入地点',
  '/世界/时间',
  '/世界/地点',
] as const;

const ENTRY_PATCH_EXAMPLE_VALUES: Record<string, string> = {
  '/墟境系统/运行状态/墟境流程状态': '"exploring"',
  '/墟境系统/运行状态/墟境任务规则锁定': '1',
  '/墟境系统/运行状态/墟境轮次': '"（本轮唯一新轮次，禁止沿用旧轮次）"',
  '/墟境系统/运行状态/本轮现实时间': '"（即上方「现实锚点时间」，逐字复制）"',
  '/墟境系统/运行状态/本轮现实地点': '"（即上方「现实锚点地点」，逐字复制）"',
  '/墟境系统/运行状态/墟境当前时间': '"（即上方「目标墟境时间」，逐字复制）"',
  '/墟境系统/运行状态/墟境当前地点': '"（即上方「目标墟境地点」，逐字复制）"',
  '/墟境系统/运行状态/本轮墟境进入时间': '"（即上方「目标墟境时间」，逐字复制）"',
  '/墟境系统/运行状态/本轮墟境进入地点': '"（即上方「目标墟境地点」，逐字复制）"',
  '/世界/时间': '"（即上方「目标墟境时间」，逐字复制）"',
  '/世界/地点': '"（即上方「目标墟境地点」，逐字复制）"',
};

/**
 * 本轮墟境轮次标识（internal.84「墟境轮次规范化」）：
 * 由脚本确定性生成并注入契约，模型逐字照抄进 `/墟境系统/运行状态/墟境轮次`。
 * 此前该字段示例值只写「本轮唯一新轮次」——由模型自由发挥，导致同一聊天内
 * 轮次风格混用（账本里 `node-2-3-run-4881017064600` 与 `Ruin-Node-Yuna-001`
 * 并存）、轮次隔离与蝴蝶 runId 关联全靠模型；现在与其余十个「逐字复制」字段同源。
 */
export function buildRuinRunId(requestId: string, nodeId: string): string {
  const compact = String(requestId ?? '')
    .replace(/[^0-9a-zA-Z]/gu, '')
    .toLowerCase();
  const tail = compact.slice(0, 8) || 'run';
  return `Ruin-${nodeId}-${tail}`;
}

/**
 * 构建注入契约末尾的「变量更新规则」段:
 * 精确 JSON Patch 路径清单 + 示例值,让模型照抄而非猜测字段结构。
 * 路径与字段名必须与时间内核白名单一致(测试防漂移)。
 * `runId` 为本轮轮次标识（buildRuinRunId 产物）：作为墟境轮次字段的确切值。
 */
export function buildRuinEntryVariableRules(runId: string): string {
  const patchLines = RUIN_ENTRY_PATCH_FIELDS.map((path, index) => {
    const comma = index < RUIN_ENTRY_PATCH_FIELDS.length - 1 ? ',' : '';
    const value = path === '/墟境系统/运行状态/墟境轮次'
      ? JSON.stringify(runId)
      : (ENTRY_PATCH_EXAMPLE_VALUES[path] ?? '""');
    return `  {"op":"replace","path":"${path}","value":${value}}${comma}`;
  });
  return [
    '<VARIABLE_UPDATE_RULES>',
    '回复末尾的完整变量更新必须逐字段输出下列 JSON Patch；路径与字段名必须逐字一致，禁止改写、省略或自造字段，禁止整根 insert/replace `/墟境系统` 或 `/墟境系统/运行状态`：',
    '[',
    ...patchLines,
    ']',
    '世界时地必须等于目标墟境时地；轮次必须逐字复制上方「本轮轮次标识」，禁止自造、改写或沿用旧轮次。',
    '时间与地点按角色卡《变量更新规则》格式书写：时间=纪元+年-月-日-星期-时:分（24小时制，星期按剧情日历推算，示例：创世纪元247年-7月-7日-星期五-19:30）；地点=大陆名+方位-势力/区域-子级势力-聚落/地标-区位-详细位置（按实际情况保留4～8层，从大到小）。目标墟境地点已经由工作台规范化，三个目标地点字段必须逐字复制，禁止缩写、改层级或自行补名。',
    '</VARIABLE_UPDATE_RULES>',
  ].join('\n');
}

/**
 * 构建进入特异点的注入契约文本(注入层内容,非玩家楼):
 * 「进入节点」+【历史工作台·单楼进入契约】+ RuinTrace 全文
 * + 变量更新规则段(JSON Patch 路径清单),
 * 由正文模型在生成时按契约承接上一楼并输出变量更新。
 */
export function buildRuinEntryContract(
  record: RuinCandidateRecord,
  candidateId: string,
  nodeId: string,
  reality: RuinEntryRealityAnchor,
): string {
  const { candidate, node } = selectEnterableRuinNode(
    record,
    candidateId,
    nodeId,
  );
  const realityTime = requireText(reality.time, 'Reality time');
  const realityLocation = requireText(reality.location, 'Reality location');
  const targetLocation = resolveRuinEntryLocation(
    node.location,
    record.input.location,
  );
  const sceneProjection = buildRuinNodeSceneProjection(node, targetLocation);
  const trace = serializeRuinTrace(
    {
      title: candidate.title,
      periodType: periodLabel(candidate.periodType),
      span: candidate.span,
      // 可见墟境面板始终展示同一份完整史稿；所选节点只影响隐藏进入契约、
      // NodeTime 与目标时地，不能把机器拼装的节点投影冒充“历史正文”。
      historyProse: candidate.historyProse,
      shift: `${periodLabel(candidate.shift.from)} → ${periodLabel(candidate.shift.to)}`,
    },
    node,
  );
  // internal.84：本轮轮次标识由脚本给定（模型逐字照抄），不再让模型自造。
  const runId = buildRuinRunId(record.requestId, node.id);
  return [
    '进入节点',
    [
      '【历史工作台·单楼进入契约】',
      `现实锚点时间：${realityTime}`,
      `现实锚点地点：${realityLocation}`,
      `目标纪元：${record.result.era}`,
      `目标墟境时间：${node.time.label}`,
      `目标墟境地点：${targetLocation}`,
      `史案标题：${candidate.title}`,
      `历史阶段：${ruinStageLabel(node.kind)}`,
      `历史节点：${node.title}`,
      `节点场景投影（本楼唯一当前现场）：${sceneProjection}`,
      `史案全局走向（只供理解前后关系，不得在本楼概述或重演）：${candidate.summary}`,
      `节点局势：${node.summary}`,
      `直接成因：${node.cause}`,
      `因果机制：${node.causalMechanism}`,
      `参与人物与组织：${joinOrNone(node.participants)}`,
      `利益与恐惧：${node.interests.map(item =>
        `${item.actor}希望${item.wants}，同时畏惧${item.fears}`
      ).join('；') || '无明确资料'}`,
      `物质条件：${joinOrNone(node.materialConditions)}`,
      `对立关系：${node.opposition || '无明确资料'}`,
      `可感知痕迹：${node.visibleTrace}`,
      `玩家可介入条件：${node.intervention || ruinStageGuidance(node.kind)}`,
      `可能分支：${node.possibleBranches.map(branch =>
        `${branch.condition} → ${branch.consequence}`
      ).join('；') || ruinStageGuidance(node.kind)}`,
      `重点参考人物落实：${candidate.selectedCharacterUsage.map(item =>
        `${item.name}（${item.mode}）：${item.role}`
      ).join('；') || '未指定重点参考人物'}`,
      `玩家补充方向：${record.input.supplementaryDirection.trim() || '无'}`,
      `本轮轮次标识：${runId}`,
      `资料标识：${record.requestId} / ${candidate.id} / ${node.id}`,
      '',
      `阶段边界：${ruinStageGuidance(node.kind)}`,
      '请直接承接上一楼尚未结束的动作、人物关系与现场氛围，自然描写从现实锚点进入上述历史节点的过程。以「节点场景投影」为本楼最高叙事权限和唯一当前现场：禁止从整篇史案的缘起重新演一遍，禁止提前演出后续节点，禁止把缘起、经过、高潮、结果合并成历史概述；只表现玩家抵达这一刻能够看见、听见、碰到并立即介入的局势。进入完成后，按现有伊雍墟境变量规则，在本楼建立唯一新轮次、锁定现实锚点、把目标时地写入世界与墟境当前时地，并将流程状态更新为 exploring。本楼只呈现节点局势，不生成墟境任务或<task_info>；等待<user>在后续楼层明确可执行、可验证的干预目标后再建立任务。回复末尾只输出一份完整变量更新。',
    ].join('\n'),
    trace,
    buildRuinEntryVariableRules(runId),
  ].join('\n\n');
}

function ruinStageLabel(kind: 'origin' | 'process' | 'anomaly' | 'result'): string {
  return {
    origin: '缘起',
    process: '经过',
    anomaly: '高潮',
    result: '结果',
  }[kind];
}

function ruinStageGuidance(kind: 'origin' | 'process' | 'anomaly' | 'result'): string {
  return {
    origin: '进入起因形成之前或正在形成的现场，可调查、阻止或改变关键前提。',
    process: '进入事态累积与扩散的现场，可影响人物选择、资源流向与制度响应。',
    anomaly: '进入因果汇聚的高潮时刻，可围绕决定性选择直接干预。',
    result: '进入既成事件的后果现场，可追查、救援、保存证据或改变后续影响；不得无因抹除已经发生的前序事件。',
  }[kind];
}

function buildRuinNodeSceneProjection(node: RuinNode, location: string): string {
  return [
    `${node.time.label}，${location}，${ruinStageLabel(node.kind)}“${node.title}”正在发生。`,
    asSentence(node.summary),
    asSentence(`现场由${node.cause}推动，并通过${node.causalMechanism}继续发展`),
    asSentence(`玩家此刻可先从“${node.visibleTrace}”察觉异样`),
    asSentence(node.intervention || ruinStageGuidance(node.kind)),
  ].join('');
}

function asSentence(value: string): string {
  const text = value.trim();
  if (!text) return '';
  return /[。！？!?]$/u.test(text) ? text : `${text}。`;
}

export class RuinEntryWorkflow {
  private epoch = 0;
  private sending: AbortController | null = null;
  private readonly inFlight = new Map<string, Promise<RuinEntrySubmission>>();
  private readonly submitted = new Set<string>();
  /** 已发送未提交的进入(triggerMessageId → submissionKey):删楼回退时释放防重 */
  private readonly pendingSubmissions = new Map<number, string>();
  private readonly repository: RuinCandidateRepository;
  private readonly host: HostAdapter;
  private readonly userTurns: UserTurnAdapter;
  private readonly runtime: TavernRuntime;
  private readonly shell: TavernRuinEntryShellAdapter;
  private readonly hooks: RuinEntryHooks;
  private pendingLock: RuinEntryFloorLock | null = null;
  private settlePoll: {
    lock: RuinEntryFloorLock;
    messageId: number;
    timer: ReturnType<typeof setInterval>;
  } | null = null;

  constructor(dependencies: {
    repository: RuinCandidateRepository;
    host: HostAdapter;
    userTurns: UserTurnAdapter;
    runtime: TavernRuntime;
    shell: TavernRuinEntryShellAdapter;
    hooks?: RuinEntryHooks;
  }) {
    this.repository = dependencies.repository;
    this.host = dependencies.host;
    this.userTurns = dependencies.userTurns;
    this.runtime = dependencies.runtime;
    this.shell = dependencies.shell;
    this.hooks = dependencies.hooks ?? {};
  }

  async enter(
    recordKey: string,
    candidateId: string,
    nodeId: string,
    playerText: string,
  ): Promise<RuinEntrySubmission> {
    const epoch = this.epoch;
    const namespace = await this.host.getNamespace();
    this.assertActive(epoch);
    const submissionKey = [
      namespaceKey(namespace),
      recordKey,
      candidateId,
      nodeId,
    ].join('::');
    if (this.submitted.has(submissionKey)) {
      throw new Error('This ruin node has already been submitted for entry');
    }
    const existing = this.inFlight.get(submissionKey);
    if (existing) return existing;
    if (this.inFlight.size || this.pendingLock) throw new Error('穿越正在进行，请等待或停止当前任务');

    const task = this.submit(
      recordKey,
      candidateId,
      nodeId,
      playerText,
      submissionKey,
      epoch,
    ).finally(() => {
      if (this.inFlight.get(submissionKey) === task) {
        this.inFlight.delete(submissionKey);
      }
    });
    this.inFlight.set(submissionKey, task);
    return task;
  }

  /**
   * 过渡期兼容入口:只准备契约文本,不发送(旧 composer 路径用)。
   * P5 实测通过后随 writeTavernComposer 一并删除。
   */
  async prepareText(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<RuinEntryPreparedText> {
    const { contractText } = await this.prepareSelection(recordKey, candidateId, nodeId);
    return { recordKey, candidateId, nodeId, text: contractText };
  }

  /**
   * 渲染事件提交入口(WorkbenchLifecycle.onAssistantRendered):
   * 断言失败 / 空内容 / 流式中都保留锁等待下一次事件,不销毁事务;
   * 断言通过且流式结束后提交:清理注入 + 元数据写回。
   */
  async commitRendered(assistantMessageId: number): Promise<RuinEntrySubmission | null> {
    const epoch = this.epoch;
    const lock = this.pendingLock;
    if (!lock) return null;
    try {
      await this.shell.assertRenderedFloor(lock, assistantMessageId);
      this.assertActive(epoch);
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.warn('[Eyon History Workbench] ruin entry rendered floor rejected; keeping transaction', {
        assistantMessageId,
        detail,
      });
      return null;
    }
    const content = await this.shell.readAssistantMessage(assistantMessageId);
    this.assertActive(epoch);
    if (!content.trim()) {
      console.warn('[Eyon History Workbench] ruin entry target floor is still empty; waiting for content', {
        assistantMessageId,
      });
      return null;
    }
    if (this.runtime.isGenerating?.() === true) {
      console.warn('[Eyon History Workbench] ruin entry narrative is still streaming; waiting for stream end', {
        assistantMessageId,
      });
      this.ensureSettlePoll(lock, assistantMessageId);
      return null;
    }
    return this.commitLock(lock, assistantMessageId);
  }

  /**
   * 聊天切换 / 取消兜底:丢锁 + 清理注入(幂等)。
   */
  async cancelPending(): Promise<void> {
    this.epoch += 1;
    this.inFlight.clear();
    this.sending?.abort(new GenerationCancelledError('ruin'));
    this.sending = null;
    this.stopSettlePoll();
    const lock = this.pendingLock;
    if (!lock) return;
    this.pendingLock = null;
    this.hooks.onStatus?.('cancelled', '本次穿越已然中断', { phase: 'cancelled' });
    try {
      await this.shell.clear(lock.requestId);
    } catch (error) {
      console.warn('[Eyon History Workbench] ruin entry injection cleanup failed', error);
    }
  }

  /**
   * 玩家楼被删除(回退)时释放防重标记,允许同一特异点重新进入。
   * 若删除的正是挂起事务的触发楼,同时取消事务并清理注入。
   */
  onMessageDeleted(messageId: number): void {
    const lock = this.pendingLock;
    if (lock && lock.triggerMessageId === messageId) {
      void this.cancelPending();
    }
    const submissionKey = this.pendingSubmissions.get(messageId);
    if (!submissionKey) return;
    this.submitted.delete(submissionKey);
    this.pendingSubmissions.delete(messageId);
  }

  private async submit(
    recordKey: string,
    candidateId: string,
    nodeId: string,
    playerText: string,
    submissionKey: string,
    epoch: number,
  ): Promise<RuinEntrySubmission> {
    const assertActive = () => this.assertActive(epoch);
    const { namespace, contractText, traceText } = await this.prepareSelection(
      recordKey,
      candidateId,
      nodeId,
    );
    assertActive();

    const namespaceBeforeSend = await this.host.getNamespace();
    assertActive();
    if (namespaceKey(namespaceBeforeSend) !== namespaceKey(namespace)) {
      throw new Error('Chat changed before the ruin entry turn was sent');
    }
    const normalizedPlayerText = resolveRuinEntryPlayerText(playerText);
    const requestId = crypto.randomUUID();
    let armed = false;
    const controller = new AbortController();
    this.sending = controller;
    const startedAt = Date.now();
    this.hooks.onStatus?.(
      'entering_ruin',
      '正在校对所选节点的时间、地点与进入契约',
      { phase: 'running', progress: { current: 1, total: 1, startedAt } },
    );
    try {
      const { messageId } = await this.userTurns.sendUserTurn(normalizedPlayerText, {
        signal: controller.signal,
        beforeCreate: async expectedMessageId => {
          const namespaceNow = await this.host.getNamespace();
          assertActive();
          if (namespaceKey(namespaceNow) !== namespaceKey(namespace)) {
            throw new Error('Chat changed while the ruin entry was being armed');
          }
          const lock: RuinEntryFloorLock = {
            requestId,
            recordKey,
            candidateId,
            nodeId,
            triggerMessageId: expectedMessageId,
            playerText: normalizedPlayerText,
            contractText,
            traceText,
            triggerTextHash: fingerprintText(normalizedPlayerText),
            triggerSwipeId: null,
            namespace,
          };
          this.pendingLock = lock;
          await this.shell.arm(lock);
          armed = true;
          if (epoch !== this.epoch) await this.shell.clear(requestId);
          assertActive();
        },
        afterCreate: async messageId => {
          assertActive();
          const lock = this.pendingLock;
          if (!lock || lock.requestId !== requestId) {
            throw new Error('Ruin entry lock was not armed before sending');
          }
          lock.triggerSwipeId = this.runtime.getMessageSwipeId(messageId);
        },
      });
      assertActive();
      if (!Number.isInteger(messageId) || messageId < 0) {
        throw new Error('Ruin entry sender did not return a valid user floor');
      }
      this.submitted.add(submissionKey);
      this.pendingSubmissions.set(messageId, submissionKey);
      this.hooks.onStatus?.(
        'entering_ruin',
        '时光之门已然洞开，正在等待这一轮正文落定',
        { phase: 'running', progress: { current: 1, total: 1, startedAt } },
      );
      return {
        recordKey,
        candidateId,
        nodeId,
        messageId,
        playerText: normalizedPlayerText,
        contractText,
      };
    } catch (error) {
      // 单向失败:任何发送失败都必须清注入、丢锁,不留半截状态
      if (this.pendingLock?.requestId === requestId) this.pendingLock = null;
      if (armed) {
        try {
          await this.shell.clear(requestId);
        } catch (cleanupError) {
          console.warn('[Eyon History Workbench] ruin entry injection cleanup failed after send failure', cleanupError);
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      if (epoch === this.epoch && !isTaskCancellationError(error)) this.hooks.onStatus?.('failed', detail, { phase: 'error' });
      throw error;
    } finally {
      if (this.sending === controller) this.sending = null;
    }
  }

  private async commitLock(
    lock: RuinEntryFloorLock,
    assistantMessageId: number,
  ): Promise<RuinEntrySubmission | null> {
    this.stopSettlePoll();
    if (this.pendingLock !== lock) return null;
    const epoch = this.epoch;
    this.pendingLock = null;
    await this.shell.clear(lock.requestId);
    this.assertActive(epoch);
    try {
      // 组装权威 [RuinTrace] 进穿越助手楼(替换模型自发块或插入正文与面板之间),
      // 先写正文再挂元数据(attach 以当前正文作分支触发器)。
      const content = await this.shell.readAssistantMessage(assistantMessageId);
      this.assertActive(epoch);
      const assembled = insertRuinTrace(content, lock.traceText);
      if (assembled !== content) {
        await this.shell.writeAssistantMessage(assistantMessageId, assembled);
        this.assertActive(epoch);
      }
      await this.shell.attachRequestMetadata(lock, assistantMessageId);
      this.assertActive(epoch);
      // 提交完成:释放防重(此后由 flowState==='idle' 检查接管),允许删楼回退后重进
      this.pendingSubmissions.delete(lock.triggerMessageId);
      this.submitted.delete([
        namespaceKey(lock.namespace),
        lock.recordKey,
        lock.candidateId,
        lock.nodeId,
      ].join('::'));
      this.hooks.onStatus?.('ready', '所选节点已进入，时间与地点已按契约落定', { phase: 'success' });
      return {
        recordKey: lock.recordKey,
        candidateId: lock.candidateId,
        nodeId: lock.nodeId,
        messageId: lock.triggerMessageId,
        playerText: lock.playerText,
        contractText: lock.contractText,
      };
    } catch (error) {
      if (isTaskCancellationError(error)) throw error;
      console.error('[Eyon History Workbench] ruin entry metadata attach failed', error);
      throw error;
    }
  }

  private assertActive(epoch: number): void {
    if (epoch !== this.epoch) throw new GenerationCancelledError('ruin');
  }

  /**
   * 流式结束兜底轮询(与传记一致):500ms 检查 isGenerating,转 false 后提交;
   * 锁被清或 60s 仍生成中则放弃,等下一次渲染事件。
   */
  private ensureSettlePoll(lock: RuinEntryFloorLock, assistantMessageId: number): void {
    if (this.settlePoll && this.settlePoll.messageId === assistantMessageId) return;
    this.stopSettlePoll();
    let checks = 0;
    const timer = setInterval(() => {
      checks += 1;
      if (this.pendingLock !== lock) {
        this.stopSettlePoll();
        return;
      }
      if (this.runtime.isGenerating?.() !== true) {
        this.stopSettlePoll();
        void this.commitLock(lock, assistantMessageId).catch(error => {
          console.error('[Eyon History Workbench] ruin entry settle commit failed', error);
        });
        return;
      }
      if (checks >= 120) {
        // 60 秒仍生成中:放弃轮询,等下一次渲染事件再评估
        this.stopSettlePoll();
      }
    }, 500);
    this.settlePoll = { lock, messageId: assistantMessageId, timer };
  }

  private stopSettlePoll(): void {
    if (this.settlePoll) {
      clearInterval(this.settlePoll.timer);
      this.settlePoll = null;
    }
  }

  private async prepareSelection(
    recordKey: string,
    candidateId: string,
    nodeId: string,
  ): Promise<{
    namespace: Awaited<ReturnType<HostAdapter['getNamespace']>>;
    contractText: string;
    traceText: string;
  }> {
    const [namespace, snapshot, record] = await Promise.all([
      this.host.getNamespace(),
      this.host.getRuinRuntimeSnapshot(),
      this.repository.get(recordKey),
    ]);
    if (!record) throw new Error('Selected ruin candidate record is unavailable');
    if (namespaceKey(record.namespace) !== namespaceKey(namespace)) {
      throw new Error('Selected ruin candidate belongs to a different chat');
    }
    if (snapshot.flowState !== 'idle') {
      throw new Error('A ruin node can only be entered from the idle state');
    }
    const contractText = buildRuinEntryContract(record, candidateId, nodeId, {
      time: snapshot.realityTime,
      location: snapshot.realityLocation,
    });
    const traceMatch = contractText.match(/\[RuinTrace\][\s\S]*?\[\/RuinTrace\]/u);
    const traceText = traceMatch?.[0] ?? '';
    return { namespace, contractText, traceText };
  }
}

function periodLabel(period: 'stable' | 'transition' | 'turbulent'): string {
  return {
    stable: '稳定期',
    transition: '过渡期',
    turbulent: '动荡期',
  }[period];
}

function joinOrNone(items: string[]): string {
  return items.filter(Boolean).join('、') || '无明确资料';
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is unavailable`);
  return normalized;
}
