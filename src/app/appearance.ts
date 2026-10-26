export interface Appearance {
  pageTitleSize: number;
  sectionTitleSize: number;
  bodyFontSize: number;
  secondaryFontSize: number;
  navFontSize: number;
  lineHeight: number;
  density: 'comfortable' | 'compact';
  accent: 'teal' | 'blue' | 'violet';
  fontFamily: 'system' | 'yahei';
  highContrast: boolean;
}

export const defaultAppearance: Readonly<Appearance> = Object.freeze({
  pageTitleSize: 28,
  sectionTitleSize: 18,
  bodyFontSize: 16,
  secondaryFontSize: 13,
  navFontSize: 15,
  lineHeight: 1.7,
  density: 'comfortable',
  accent: 'teal',
  fontFamily: 'system',
  highContrast: true,
});

export const fontSizeOptions = [
  { key: 'pageTitleSize', label: '页面标题字号', description: '每个页面顶部的大标题', min: 24, max: 40 },
  { key: 'sectionTitleSize', label: '分区标题字号', description: '卡片、说明章节和设置分组标题', min: 16, max: 30 },
  { key: 'bodyFontSize', label: '正文字号', description: '说明正文、任务名称、按钮和输入框', min: 12, max: 24 },
  { key: 'secondaryFontSize', label: '辅助文字字号', description: '时间、路径、状态标签和提示说明', min: 11, max: 18 },
  { key: 'navFontSize', label: '导航字号', description: '侧栏菜单和说明书目录', min: 13, max: 20 },
] as const;

export const appearancePresets: Array<{ id: string; label: string; value: Appearance }> = [
  { id: 'standard', label: '标准阅读', value: { ...defaultAppearance } },
  {
    id: 'large', label: '大字阅读', value: {
      ...defaultAppearance, pageTitleSize: 32, sectionTitleSize: 20, bodyFontSize: 18,
      secondaryFontSize: 15, navFontSize: 17, lineHeight: 1.8,
    }
  },
  {
    id: 'compact', label: '紧凑显示', value: {
      ...defaultAppearance, pageTitleSize: 26, sectionTitleSize: 17, bodyFontSize: 14,
      secondaryFontSize: 12, navFontSize: 14, lineHeight: 1.6, density: 'compact',
    }
  },
];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const validFont = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

// 老数据库未保存外观时补默认；部分旧字段或损坏值逐项回退，不丢监控设置。
export function normalizeAppearance(value: unknown): Appearance {
  const raw = record(value);
  const appearance: Appearance = { ...defaultAppearance };
  for (const option of fontSizeOptions) if (validFont(raw[option.key], option.min, option.max)) {
    appearance[option.key] = raw[option.key] as number;
  }
  if (typeof raw.lineHeight === 'number' && Number.isFinite(raw.lineHeight) && raw.lineHeight >= 1.4 && raw.lineHeight <= 2.2) appearance.lineHeight = raw.lineHeight;
  if (raw.density === 'comfortable' || raw.density === 'compact') appearance.density = raw.density;
  if (raw.accent === 'teal' || raw.accent === 'blue' || raw.accent === 'violet') appearance.accent = raw.accent;
  if (raw.fontFamily === 'system' || raw.fontFamily === 'yahei') appearance.fontFamily = raw.fontFamily;
  if (typeof raw.highContrast === 'boolean') appearance.highContrast = raw.highContrast;
  return appearance;
}

export function validateAppearance(value: unknown): Appearance {
  const raw = record(value);
  const normalized = normalizeAppearance(raw);
  for (const key of Object.keys(defaultAppearance) as Array<keyof Appearance>) {
    if (raw[key] !== normalized[key]) throw new Error('外观设置无效，请检查字号、行高和选项范围');
  }
  return normalized;
}
