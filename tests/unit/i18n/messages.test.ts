/**
 * tests/unit/i18n/messages — 语言包完整性 / 占位符 / 静态标记 / 无内联中文残留（ADR-0026 §1、§7）。
 *
 * 这是 i18n 的「守护测试」：新增文案绕过词条层、或某个语言漏翻，都会在这里红。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { en } from '../../../src/i18n/messages/en/pack';
import { app as enApp } from '../../../src/i18n/messages/en/app';
import { core as enCore } from '../../../src/i18n/messages/en/core';
import { view as enView } from '../../../src/i18n/messages/en/view';
import { zhCN } from '../../../src/i18n/messages/zh-CN/pack';
import { app as zhApp } from '../../../src/i18n/messages/zh-CN/app';
import { core as zhCore } from '../../../src/i18n/messages/zh-CN/core';
import { view as zhView } from '../../../src/i18n/messages/zh-CN/view';
import type { Message, MessageTable } from '../../../src/i18n/types';
import { LANGUAGES } from '../../../src/i18n/languages';

const ROOT = path.resolve(import.meta.dirname, '../../..');
type MessageKey = keyof typeof en;

/** 词条里出现的占位符集合（复数两形取并集）。 */
function placeholderSet(message: Message): Set<string> {
  const forms = typeof message === 'string' ? [message] : [message.one, message.other];
  const found = new Set<string>();
  for (const form of forms) {
    for (const match of form.matchAll(/\{(\w+)\}/g)) found.add(match[1]);
  }
  return found;
}

function sortedKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).sort();
}

describe('语言包 key 完整性', () => {
  it('en 与 zh-CN 的 key 集合一致', () => {
    expect(sortedKeys(zhCN)).toEqual(sortedKeys(en));
  });

  it('每个 key 都有非空词条（两种语言）', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      for (const table of [en, zhCN] as Record<string, Message>[]) {
        const message = table[key];
        expect(message, `missing ${key}`).toBeDefined();
        const forms = typeof message === 'string' ? [message] : [message.one, message.other];
        expect(forms.every((form) => form.length > 0), `empty ${key}`).toBe(true);
      }
    }
  });

  it('key 按层分命名空间（app.* / view.* / core.*）', () => {
    for (const key of Object.keys(en)) {
      expect(key).toMatch(/^(app|view|core)\./);
    }
  });

  it('分片模块没有重复 key（合并后数量 = 各分片之和）', () => {
    for (const parts of [
      [enApp, enView, enCore],
      [zhApp, zhView, zhCore],
    ]) {
      const sum = parts.reduce((total, part) => total + Object.keys(part).length, 0);
      const merged = new Set(parts.flatMap((part) => Object.keys(part)));
      expect(merged.size).toBe(sum);
    }
  });

  it('注册表里每个语言包都完整（key 集 + 占位符与 en 一致；懒加载包同样受守护）', async () => {
    for (const language of LANGUAGES) {
      expect(language.load, `${language.tag} 缺少 loader`).toBeTypeOf('function');
      const table: MessageTable = await language.load!();
      expect(sortedKeys(table), `${language.tag} key 集不完整`).toEqual(sortedKeys(en));
      for (const key of Object.keys(en) as MessageKey[]) {
        expect(
          [...placeholderSet(table[key] ?? '')].sort(),
          `${language.tag} 占位符不一致: ${key}`,
        ).toEqual([...placeholderSet(en[key])].sort());
      }
    }
  });

  it('中英占位符集合一致（{n} / {name} 等不能漏）', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect([...placeholderSet(zhCN[key])].sort(), `placeholders differ: ${key}`).toEqual(
        [...placeholderSet(en[key])].sort(),
      );
    }
  });
});

/** 去掉 HTML 注释（只用于扫残留，不参与渲染）。 */
function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** 收集 page.html 里 data-i18n / data-i18n-attr 引用的 key。 */
function domMessageKeys(html: string): string[] {
  const keys: string[] = [];
  for (const match of html.matchAll(/data-i18n="([^"]+)"/g)) keys.push(match[1]);
  for (const match of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for (const pair of match[1].split(',')) {
      const colon = pair.indexOf(':');
      if (colon > 0) keys.push(pair.slice(colon + 1).trim());
    }
  }
  return keys;
}

describe('page.html 静态标记', () => {
  const html = stripHtmlComments(readFileSync(path.join(ROOT, 'src/app/page.html'), 'utf8'));

  it('每个 data-i18n / data-i18n-attr key 都存在于 en 与 zh-CN', () => {
    const keys = domMessageKeys(html);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(en, `missing en key for <${key}>`).toHaveProperty(key);
      expect(zhCN, `missing zh key for <${key}>`).toHaveProperty(key);
    }
  });

  it('默认文案是英文（语言包异步加载期间不空白；中文默认值必须走 data-i18n）', () => {
    // 注释去掉后，HTML 里不应再有 CJK
    expect([...html.matchAll(/[\u4e00-\u9fff]/g)]).toHaveLength(0);
    // 简单文本节点（`data-i18n="key">TEXT<`）的默认文案必须逐字等于 en 词条
    let checked = 0;
    for (const match of html.matchAll(/data-i18n="([^"]+)">([^<]*)</g)) {
      const key = match[1];
      const text = match[2];
      const enMessage = en[key as keyof typeof en];
      if (typeof enMessage !== 'string') continue; // 复数形 / 分裂节点跳过
      expect(text, `<${key}> 默认文案与 en 词条不一致`).toBe(enMessage);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

/* ---------------- 无内联中文残留守护 ---------------- */

const CJK = /[\u4e00-\u9fff]/;
/** 语言包本身、测试、脚本、文档白名单；`languages.ts` 的语言自称（简体中文）按设计不翻译。 */
const SCAN_EXCLUDES = ['src/i18n/messages', 'tests/', 'scripts/', 'docs/', '.spike/', 'dist/'];
const SCAN_FILE_ALLOWLIST = new Set(['src/i18n/languages.ts']);

function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (SCAN_EXCLUDES.some((prefix) => rel.startsWith(prefix) || `${rel}/`.startsWith(prefix))) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) listSourceFiles(full, out);
    else if (/\.(ts|html)$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * 用 TypeScript 自己的 parser 扫**字符串字面量 / 模板串静态片段**里的 CJK：
 * 注释、正则字面量、标识符天然不在扫描面内（比手写 lexer 可靠）。
 */
function findInlineCjk(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      text = node.text;
    } else if (ts.isTemplateExpression(node)) {
      text =
        node.head.text +
        node.templateSpans.map((span) => span.literal.text).join('');
    }
    if (text !== null && CJK.test(text)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      hits.push(`line ${line}: ${text.slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

describe('无内联中文残留（文案必须走词条层）', () => {
  it('src/**（语言包除外）的用户可见字面量不再含中文', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(path.join(ROOT, 'src'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (rel.endsWith('page.html')) continue; // HTML 由上一个用例按注释剥离后单独校验
      if (SCAN_FILE_ALLOWLIST.has(rel)) continue;
      const source = readFileSync(file, 'utf8');
      for (const hit of findInlineCjk(file, source)) violations.push(`${rel} ${hit}`);
    }
    expect(violations, `发现未走词条层的中文字面量:\n${violations.join('\n')}`).toEqual([]);
  });
});
