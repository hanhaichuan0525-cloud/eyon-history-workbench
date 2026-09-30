/**
 * 版本口径：对外 β1.5，更新协议数字版 0.13.3。
 *
 * - 对外可见的版本名一律用 `WORKBENCH_VERSION_LABEL`（工作台左上角、设置页、README）。
 * - 更新机制仍必须使用三段数字版本 `WORKBENCH_VERSION`：自动更新加载器会拒绝
 *   `^\d+\.\d+\.\d+$` 之外的 manifest.version，扩展更新检查也按数字比较新旧，
 *   展示名不参与版本比较，manifest/package 始终使用三段数字。
 */
export const WORKBENCH_VERSION_LABEL = 'β1.5';

/**
 * β1.5 发布：收录 0.13.0—0.13.2 已实现的身份、出场与移动端修复。
 * 使用新数字版本，避免覆盖已交付的 0.13.2 本地包。
 */
export const WORKBENCH_VERSION = '0.13.3';
