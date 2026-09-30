/**
 * 版本口径：对外 β1.6，数字更新协议 0.14.4。
 *
 * - 对外可见的版本名一律用 `WORKBENCH_VERSION_LABEL`（工作台左上角、设置页、README）。
 * - 更新机制仍必须使用三段数字版本 `WORKBENCH_VERSION`：自动更新加载器会拒绝
 *   `^\d+\.\d+\.\d+$` 之外的 manifest.version，扩展更新检查也按数字比较新旧，
 *   展示名不参与版本比较，manifest/package 始终使用三段数字。
 */
export const WORKBENCH_VERSION_LABEL = 'β1.6';

/**
 * 发布既有特殊谱系、检索与已知事件选时修复；显示名不参与版本比较。
 * β1 自动加载器代码保持不变，旧离线包保留；完整刷新后远端加载新版。
 */
export const WORKBENCH_VERSION = '0.14.4';
