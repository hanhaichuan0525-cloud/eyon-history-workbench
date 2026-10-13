import type { WorkbenchSettings } from '../runtime/workbenchSettings.ts';
import { COURT_FONT_STACKS, courtReadingSize } from './courtTypography.ts';
import courtModuleCss from './courtModule.css?raw';
export { courtModuleCss };

export type WorkbenchAppearance = WorkbenchSettings['appearance'];

const ACCENTS: Record<WorkbenchAppearance['accent'], {
  base: string;
  bright: string;
  line: string;
}> = {
  jade: {
    base: '#668f87',
    bright: '#87aaa3',
    line: 'rgba(102, 143, 135, .36)',
  },
  gold: {
    base: '#9b825f',
    bright: '#b9a17d',
    line: 'rgba(155, 130, 95, .38)',
  },
  blue: {
    base: '#72889c',
    bright: '#92a6b8',
    line: 'rgba(114, 136, 156, .38)',
  },
  crimson: {
    base: '#9a6672',
    bright: '#bd8792',
    line: 'rgba(154, 102, 114, .4)',
  },
};

const TEXTS: Record<WorkbenchAppearance['text'], {
  dark: [string, string];
  light: [string, string];
}> = {
  neutral: {
    dark: ['#ece7ee', '#aaa1ae'],
    light: ['#2f2932', '#756d78'],
  },
  warm: {
    dark: ['#eee2dc', '#b1a0a1'],
    light: ['#3b3034', '#7b696e'],
  },
  cool: {
    dark: ['#e5e8ed', '#9ba4b1'],
    light: ['#2d333d', '#6a7482'],
  },
};

export function applyAppearance(
  target: HTMLElement,
  appearance: WorkbenchAppearance,
): void {
  const accent = ACCENTS[appearance.accent];
  const [ink, muted] = TEXTS[appearance.text][appearance.mode];
  const isLight = appearance.mode === 'light';
  target.style.setProperty('--archive-bg', isLight ? '#e3dde9' : '#100d17');
  target.style.setProperty('--archive-panel', isLight ? '#f2edf5' : '#201b2b');
  target.style.setProperty('--archive-surface', isLight ? '#f2edf5' : '#201b2b');
  target.style.setProperty('--archive-surface-soft', isLight ? '#e8e0ef' : '#15111e');
  target.style.setProperty('--archive-surface-raised', isLight ? '#fffaff' : '#292232');
  target.style.setProperty('--archive-input', isLight ? '#e8e0ef' : '#15111e');
  target.style.setProperty('--archive-line', isLight ? '#b3a2c2' : '#51445f');
  target.style.setProperty('--archive-line-strong', isLight ? '#9273aa' : '#79608d');
  target.style.setProperty('--archive-faint', isLight ? '#8d848f' : '#807884');
  target.style.setProperty('--archive-gold', isLight ? '#9b825f' : '#b49c78');
  target.style.setProperty('--archive-gold-2', isLight ? '#745f45' : '#c6b08e');
  target.style.setProperty('--archive-paper', isLight ? '#f4eee6' : '#d9c9b0');
  target.style.setProperty('--archive-paper-text', '#403441');
  target.style.setProperty('--archive-radius-control', '9px');
  target.style.setProperty('--archive-radius-panel', '15px');
  target.style.setProperty('--archive-radius-major', '21px');
  target.style.setProperty('--teal', accent.base);
  target.style.setProperty('--teal-2', accent.bright);
  target.style.setProperty('--teal-line', accent.line);
  target.style.setProperty('--ink', ink);
  target.style.setProperty('--muted', muted);
  target.style.setProperty('--court-ink', ink);
  target.style.setProperty('--court-muted', muted);
  const proseFont = appearance.proseFont ?? 'zhenkai';
  // Legacy uiFont is retained in backups, but cannot change interface typography.
  target.style.setProperty('--font-ui', COURT_FONT_STACKS.mixed);
  target.style.setProperty('--font-reading', COURT_FONT_STACKS.song);
  target.style.setProperty('--font-prose', COURT_FONT_STACKS[proseFont]);
  target.style.setProperty('--reading-size', `${courtReadingSize(appearance)}px`);
}
