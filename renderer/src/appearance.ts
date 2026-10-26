import { normalizeAppearance } from '../../src/app/appearance.ts';
import type { Appearance } from '../../src/app/appearance.ts';

function mix(hex: string, ratio: number, target = 255): string {
  const rgb = [1, 3, 5].map(offset => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16);
    return Math.round(value + (target - value) * ratio).toString(16).padStart(2, '0');
  });
  return '#' + rgb.join('');
}

export function applyAppearance(value: Appearance) {
  const appearance = normalizeAppearance(value);
  const style = document.documentElement.style;
  const accent = { teal: '#128574', blue: '#3569b6', violet: '#7b56b1' }[appearance.accent];
  const variables: Record<string, string> = {
    '--font-page-title': `${appearance.pageTitleSize}px`,
    '--font-section': `${appearance.sectionTitleSize}px`,
    '--font-body': `${appearance.bodyFontSize}px`,
    '--font-secondary': `${appearance.secondaryFontSize}px`,
    '--font-nav': `${appearance.navFontSize}px`,
    '--content-line-height': String(appearance.lineHeight),
    '--app-font-family': appearance.fontFamily === 'yahei'
      ? '"Microsoft YaHei", "Microsoft YaHei UI", sans-serif'
      : '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    '--text-body': appearance.highContrast ? '#344d58' : '#526b75',
    '--text-secondary': appearance.highContrast ? '#607780' : '#81949b',
    '--accent': accent, '--accent-soft': mix(accent, 0.92), '--accent-border': mix(accent, 0.75),
    '--accent-ink': mix(accent, 0.18, 0), '--nav-active-bg': mix(accent, 0.5, 0),
    '--el-color-primary': accent, '--el-color-primary-dark-2': mix(accent, 0.2, 0),
    '--el-font-size-base': `${appearance.bodyFontSize}px`,
    '--el-font-size-small': `${appearance.secondaryFontSize}px`,
    '--el-font-size-extra-small': `${appearance.secondaryFontSize}px`,
    '--el-font-size-large': `${appearance.sectionTitleSize}px`,
    '--el-font-size-medium': `${appearance.bodyFontSize}px`,
    '--el-font-size-extra-large': `${appearance.pageTitleSize}px`,
    '--el-text-color-regular': appearance.highContrast ? '#344d58' : '#526b75',
    '--el-text-color-secondary': appearance.highContrast ? '#607780' : '#81949b',
    '--el-component-size': appearance.density === 'compact' ? '34px' : '40px',
    '--row-padding': appearance.density === 'compact' ? '12px' : '20px',
    '--card-padding': appearance.density === 'compact' ? '18px' : '26px',
    '--section-gap': appearance.density === 'compact' ? '18px' : '28px',
  };
  for (const level of [3, 5, 7, 8, 9]) variables[`--el-color-primary-light-${level}`] = mix(accent, level / 10);
  for (const [key, entry] of Object.entries(variables)) style.setProperty(key, entry);
  document.documentElement.dataset.density = appearance.density;
}
