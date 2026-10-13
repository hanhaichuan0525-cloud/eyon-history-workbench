export const COURT_FONT_OPTIONS = [
  ['zhenkai', '霞鹜臻楷'], ['sans', '系统黑体'], ['song', '系统宋体'],
  ['kai', '系统楷体'], ['fang', '系统仿宋'],
] as const;
export const COURT_FONT_STACKS = {
  mixed: '"Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif',
  zhenkai: '"EyonCourtKai", "LXGW ZhenKai", "Kaiti SC", STKaiti, KaiTi, serif',
  sans: '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
  song: '"Noto Serif SC", "Songti SC", STSong, SimSun, serif',
  kai: '"Kaiti SC", STKaiti, KaiTi, "Noto Serif SC", serif',
  fang: 'STFangsong, FangSong, "Noto Serif SC", serif',
} as const;
import type { WorkbenchSettings } from '../runtime/workbenchSettings.ts';

/** Reduce the former automatic 18px default once; explicit new choices persist. */
export function courtReadingSize(appearance: WorkbenchSettings['appearance']): number {
  if (!appearance.readingSizeVersion && appearance.readingSize === 18) return 14;
  return appearance.readingSize ?? 14;
}

