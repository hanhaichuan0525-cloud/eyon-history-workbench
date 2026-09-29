/**
 * 版本口径（β1）。
 *
 * - 对外可见的版本名一律用 `WORKBENCH_VERSION_LABEL`（工作台左上角、设置页、README）。
 * - 更新机制仍必须使用三段数字版本 `WORKBENCH_VERSION`：自动更新加载器会拒绝
 *   `^\d+\.\d+\.\d+$` 之外的 manifest.version，扩展更新检查也按数字比较新旧，
 *   因此"β1"只能是展示名，不能写进 manifest/package 的 version 字段。
 */
export const WORKBENCH_VERSION_LABEL = 'β1';

export const WORKBENCH_VERSION = '0.12.0';
