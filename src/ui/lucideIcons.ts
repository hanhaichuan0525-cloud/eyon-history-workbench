import {
  Archive,
  Blocks,
  BookOpenCheck,
  Circle,
  Crown,
  DatabaseZap,
  Download,
  Flame,
  MoonStar,
  Palette,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Snowflake,
  Sun,
  SunMedium,
  Trash2,
  Waves,
  Waypoints,
  createElement as createLucideElement,
  type IconNode,
} from 'lucide';

const ICONS = {
  archive: Archive,
  blocks: Blocks,
  'book-open-check': BookOpenCheck,
  circle: Circle,
  crown: Crown,
  'database-zap': DatabaseZap,
  download: Download,
  flame: Flame,
  'moon-star': MoonStar,
  palette: Palette,
  'plug-zap': PlugZap,
  radio: Radio,
  'refresh-cw': RefreshCw,
  save: Save,
  'shield-check': ShieldCheck,
  snowflake: Snowflake,
  sun: Sun,
  'sun-medium': SunMedium,
  trash: Trash2,
  waves: Waves,
  waypoints: Waypoints,
} satisfies Record<string, IconNode>;

export type WorkbenchIconName = keyof typeof ICONS;

export function icon(name: WorkbenchIconName): string {
  return `<i data-workbench-icon="${name}" aria-hidden="true"></i>`;
}

export function hydrateWorkbenchIcons(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-workbench-icon]').forEach(placeholder => {
    const name = placeholder.dataset.workbenchIcon as WorkbenchIconName | undefined;
    if (!name || !ICONS[name]) return;
    const svg = createLucideElement(ICONS[name]);
    svg.setAttribute('aria-hidden', 'true');
    placeholder.replaceWith(svg);
  });
}
