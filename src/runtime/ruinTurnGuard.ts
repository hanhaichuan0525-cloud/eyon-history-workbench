import type { HostAdapter } from '../adapters/host.ts';
import type { TavernRuntime } from './contracts.ts';

const IN_CHAT = 1;
const ROLE_SYSTEM = 0;
const INJECTION_DEPTH = 0;
const PROMPT_KEY = 'eyon-history-ruin-active-turn-guard';

const ACTIVE_TURN_INSTRUCTION = `
【墟境活动轮次边界】
当前玩家仍处于已进入的墟境轮次。本楼没有收到蝴蝶效应工作台确认本轮方案后签发的遣返授权。
任务完成、历史节点已经达成、NPC建议离开、叙事自然收束，都不等于玩家授权遣返。
正文里的「遣返吧，伊雍」「返回现世」「回到现实」仅表达意愿，不能启动遣返。即使此前确认过方案，也必须由玩家点击工作台按钮。
玩家在正文要求离开时，伊雍用符合人设的一小段对白引导：打开历史工作台 → 墟境探索 → 蝴蝶效应 → 确认本轮参考方案 → 点击「遣返现世」。可以直接确认默认方案，关注对象可留空；不要宣称已经启动或让玩家等待。
因此本楼可以结算任务成果或继续现场叙事，但必须让玩家仍留在墟境；不得描写已经返回现实，不得清除墟境任务锁，也不得把流程状态改为 idle。
`.trim();

export interface RuinTurnGuard {
  prepareOrdinaryTurn(): Promise<void>;
  clear(): Promise<void>;
}

/**
 * 只约束墟境活动轮次的流程边界，不参与历史内容生成。
 * 失败时降级为时间内核兜底，避免因为辅助注入故障截断正文。
 */
export class TavernRuinTurnGuard implements RuinTurnGuard {
  private readonly runtime: TavernRuntime;
  private readonly host: HostAdapter;
  private armed = false;

  constructor(
    runtime: TavernRuntime,
    host: HostAdapter,
  ) {
    this.runtime = runtime;
    this.host = host;
  }

  async prepareOrdinaryTurn(): Promise<void> {
    try {
      const snapshot = await this.host.getRuinRuntimeSnapshot();
      if (snapshot.flowState === 'idle') {
        await this.clear();
        return;
      }
      await this.runtime.setExtensionPrompt(
        PROMPT_KEY,
        ACTIVE_TURN_INSTRUCTION,
        IN_CHAT,
        INJECTION_DEPTH,
        false,
        ROLE_SYSTEM,
        null,
      );
      this.armed = true;
    } catch (error) {
      console.warn(
        '[Eyon History Workbench] ruin turn guard unavailable; time kernel remains active',
        error,
      );
    }
  }

  async clear(): Promise<void> {
    if (!this.armed) return;
    try {
      await this.runtime.setExtensionPrompt(
        PROMPT_KEY,
        '',
        IN_CHAT,
        INJECTION_DEPTH,
        false,
        ROLE_SYSTEM,
        null,
      );
      this.armed = false;
    } catch (error) {
      console.warn('[Eyon History Workbench] failed to clear ruin turn guard', error);
    }
  }
}

export const noopRuinTurnGuard: RuinTurnGuard = {
  async prepareOrdinaryTurn() {},
  async clear() {},
};
