/**
 * 对外展示版本：β1.9；数字更新协议：0.14.26。
 *
 * - 对外可见的版本名一律用 `WORKBENCH_VERSION_LABEL`（工作台左上角、设置页、README）。
 * - 更新机制仍必须使用三段数字版本 `WORKBENCH_VERSION`：自动更新加载器会拒绝
 *   `^\d+\.\d+\.\d+$` 之外的 manifest.version，扩展更新检查也按数字比较新旧，
 *   展示名不参与版本比较，manifest/package 始终使用三段数字。
 */
export const WORKBENCH_VERSION_LABEL = 'β1.9';

/**
 * 保留此前修复与30:70分栏，蝴蝶控制台采用短选项、两句组合提示和三组圆角卡片。
 * 固定 β1 自动加载器代码保持不变；显示名不参与版本比较。
 */
export const WORKBENCH_VERSION = '0.14.26';
