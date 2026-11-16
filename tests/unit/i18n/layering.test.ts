/**
 * tests/unit/i18n/layering — 依赖方向守护（ADR-0026 §1 / seams.md §1）。
 *
 * `i18n` 是叶子：只允许 `view` / `app` 依赖它；`core` / `shared` / `viewmodel` 只能
 * `import type` 零依赖类型（如 `LocalePref`），**不得 value-import**（否则 worker 安全、
 * shared 零依赖两条边界会被破坏）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const GUARDED_DIRS = ['src/core', 'src/shared', 'src/viewmodel'];

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) listTs(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 模块说明符是否指向 i18n 的运行时入口（type-only import 允许）。 */
function isI18nRuntimeSpecifier(spec: string): boolean {
  return spec.startsWith('../i18n') || spec.startsWith('../../i18n') || spec.startsWith('../../../i18n');
}

describe('依赖方向：i18n 只被 view / app 消费', () => {
  it('core / shared / viewmodel 不 value-import i18n', () => {
    const violations: string[] = [];
    for (const dir of GUARDED_DIRS) {
      for (const file of listTs(path.join(ROOT, dir))) {
        const source = readFileSync(file, 'utf8');
        const sourceFile = ts.createSourceFile(
          file,
          source,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        for (const statement of sourceFile.statements) {
          if (!ts.isImportDeclaration(statement)) continue;
          const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
          if (!isI18nRuntimeSpecifier(spec)) continue;
          const typeOnly = statement.importClause?.isTypeOnly === true;
          if (typeOnly) continue;
          const rel = path.relative(ROOT, file).split(path.sep).join('/');
          const line = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
          violations.push(`${rel}:${line} → ${spec}`);
        }
      }
    }
    expect(violations, `以下文件 value-import 了 i18n（应移到 view 层或改 import type）:\n${violations.join('\n')}`).toEqual([]);
  });

  it('core 侧不 import 任何 i18n 模块（含 type）', () => {
    const violations: string[] = [];
    for (const file of listTs(path.join(ROOT, 'src/core'))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (/from\s+['"][^'"]*i18n/.test(readFileSync(file, 'utf8'))) violations.push(rel);
    }
    expect(violations).toEqual([]);
  });
});
