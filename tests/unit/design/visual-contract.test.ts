/**
 * 视觉契约（ADR-0016 / #21）：静态守住 token、字号表与对比度。
 *
 * 这层测试不碰 DOM（仓库不引 jsdom），只解析 CSS 源文件：
 *   1. CSS 里引用的每个 `var(--x)` 都必须在 tokens.css 定义（或登记为运行期变量）；
 *   2. 组件 CSS 不得出现 raw `font-size: Npx` / `font: Npx` 简写（字号只用 --text-* 八档）；
 *   3. 承担正文的 token 在深/亮两套主题下对比度 ≥ 4.5:1（ADR-0016 §2.3）；
 *   4. 尺寸 token 必须被引用；stale 提示条不得改变布局高度（§2.7）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const TOKENS = 'src/view/styles/tokens.css';
const COMPONENT_CSS = [
  'src/app/styles/shell.css',
  'src/view/tree/tree.css',
  'src/view/raw/raw-view.css',
  'src/view/panels/search-panel.css',
  'src/view/panels/settings-panel.css',
  'src/view/panels/outline-panel.css',
  'src/view/tab-strip.css',
];

/** tokens.css 里的运行期变量（由 TS 写 inline style，不在 tokens.css 声明）。 */
const RUNTIME_VARS = new Set(['--outline-row-h', '--o-depth']);

function extractBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`block not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

interface ThemeTokens {
  colors: Map<string, string>;
  all: Set<string>;
}

function parseTokens(): { dark: ThemeTokens; light: ThemeTokens } {
  const css = read(TOKENS);
  const parse = (block: string): ThemeTokens => {
    const colors = new Map<string, string>();
    const all = new Set<string>();
    for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      const name = m[1];
      const value = m[2].trim();
      all.add(name);
      if (/^(#[0-9a-f]{3,8}|rgba?\()/i.test(value)) colors.set(name, value);
    }
    return { colors, all };
  };
  return {
    dark: parse(extractBlock(css, ':root,')),
    light: parse(extractBlock(css, '[data-theme="light"]')),
  };
}

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(value: string): Rgb | null {
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1];
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

function composite(fg: Rgb, bg: Rgb): Rgb {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const { dark, light } = parseTokens();
const themes = { dark, light } as const;

const SURFACES = ['--bg-app', '--bg-panel', '--bg-panel-2', '--bg-elevated', '--bg-input'];
const UI_TEXT = ['--text', '--text-2', '--muted', '--faint'];
const SYNTAX = [
  '--syntax-key',
  '--syntax-string',
  '--syntax-number',
  '--syntax-boolean',
  '--syntax-null',
  '--syntax-punct',
  '--syntax-index',
];

function colorOf(theme: ThemeTokens, name: string): Rgb {
  const raw = theme.colors.get(name);
  if (!raw) throw new Error(`token has no color value: ${name}`);
  const parsed = parseColor(raw);
  if (!parsed) throw new Error(`unparsable color ${name}=${raw}`);
  return parsed;
}

describe('视觉契约：token 定义与引用（ADR-0016 §2.1）', () => {
  const defined = new Set([...dark.all, ...light.all, ...RUNTIME_VARS]);
  const referenced = new Set<string>();
  for (const file of [...COMPONENT_CSS, TOKENS]) {
    for (const m of read(file).matchAll(/var\((--[a-z0-9-]+)/g)) referenced.add(m[1]);
  }

  it('CSS 引用的每个 var(--x) 都已定义', () => {
    const missing = [...referenced].filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('尺寸 / 布局 token 已定义并被引用', () => {
    const required = [
      '--activity-w',
      '--left-panel-w',
      '--rail-w',
      '--tree-max',
      '--menu-item-h',
      '--result-row-h',
      '--backdrop',
    ];
    for (const name of required) {
      expect(defined.has(name), `${name} 未在 tokens.css 定义`).toBe(true);
      expect(referenced.has(name), `${name} 定义后零引用`).toBe(true);
    }
  });

  it('已删除的重复 token 不再出现', () => {
    const removed = [
      '--banner-h',
      '--map-w',
      '--radius-xl',
      '--ease-in-out',
      '--dur-slow',
      '--shadow-accent',
      '--overlay',
      '--bg-pressed',
      '--warn-soft',
      '--danger-soft',
    ];
    for (const name of removed) expect(defined.has(name), `${name} 应已删除`).toBe(false);
  });
});

describe('视觉契约：字号表（ADR-0016 §2.2）', () => {
  it('组件 CSS 不出现 raw px 字号（含 font 简写）', () => {
    const offenders: string[] = [];
    for (const file of COMPONENT_CSS) {
      read(file)
        .split('\n')
        .forEach((line, i) => {
          if (/font-size:\s*[0-9.]+px/.test(line) || /font:\s*[0-9.]+px/.test(line)) {
            offenders.push(`${file}:${i + 1} ${line.trim()}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });

  it('字号 token 八档齐全（+1 档口径）', () => {
    const expected: Record<string, string> = {
      '--text-micro': '11px',
      '--text-caption': '12px',
      '--text-small': '13px',
      '--text-body': '14px',
      '--text-mono': '13.5px',
      '--text-title': '17px',
      '--text-display-sm': '22px',
      '--text-display': '24px',
    };
    const css = read(TOKENS);
    for (const [name, value] of Object.entries(expected)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });
});

describe('视觉契约：对比度（ADR-0016 §2.3，正文 ≥4.5:1）', () => {
  for (const themeName of ['dark', 'light'] as const) {
    const theme = themes[themeName];

    it(`${themeName}: UI 文本 token 在所有 surface 上 ≥4.5:1`, () => {
      const failures: string[] = [];
      for (const fgName of UI_TEXT) {
        for (const bgName of SURFACES) {
          const fg = composite(colorOf(theme, fgName), colorOf(theme, bgName));
          const ratio = contrast(fg, colorOf(theme, bgName));
          if (ratio < 4.5) failures.push(`${fgName} on ${bgName} = ${ratio.toFixed(2)}`);
        }
      }
      expect(failures).toEqual([]);
    });

    it(`${themeName}: 语法色在树背景上 ≥4.5:1`, () => {
      const bg = colorOf(theme, '--bg-app');
      const failures: string[] = [];
      for (const fgName of SYNTAX) {
        const ratio = contrast(colorOf(theme, fgName), bg);
        if (ratio < 4.5) failures.push(`${fgName} = ${ratio.toFixed(2)}`);
      }
      expect(failures).toEqual([]);
    });

    it(`${themeName}: 强调底上的文字 ≥4.5:1`, () => {
      const ratio = contrast(colorOf(theme, '--text-on-accent'), colorOf(theme, '--accent'));
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('视觉契约：stale 提示条不改变布局高度（ADR-0016 §2.7）', () => {
  it('树与原文视图的 stale 伪元素都用负 margin 抵消 2px', () => {
    const tree = read('src/view/tree/tree.css');
    const raw = read('src/view/raw/raw-view.css');
    for (const css of [tree, raw]) {
      const rule = extractBlock(css, 'is-stale::before');
      expect(rule).toContain('height: 2px;');
      expect(rule).toContain('margin-bottom: -2px;');
    }
  });
});

/** 取一个可能含嵌套块的 CSS 块（媒体查询里还包着 `:root` 块）。 */
function extractBracedBlock(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`block not found: ${selector}`);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${selector}`);
}

describe('视觉契约：响应式断点（ADR-0017 / direction.md §3）', () => {
  const css = read(TOKENS);

  it('默认档 = 面板 320 / 右栏 300 / 树 1280', () => {
    const base = extractBlock(css, ':root,');
    expect(base).toContain('--left-panel-w: 320px;');
    expect(base).toContain('--rail-w: 300px;');
    expect(base).toContain('--tree-max: 1280px;');
  });

  it('≤1320px 断点把三个布局 token 收一档', () => {
    const media = extractBracedBlock(css, '@media (max-width: 1320px)');
    const root = extractBracedBlock(media, ':root');
    expect(root).toContain('--left-panel-w: 300px;');
    expect(root).toContain('--rail-w: 284px;');
    expect(root).toContain('--tree-max: 980px;');
  });
});
