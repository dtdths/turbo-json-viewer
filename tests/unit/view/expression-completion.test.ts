/**
 * tests/unit/view/expression-completion — #45 / ADR-0026 §4：结构化 `CompletionDetail` → CM6 detail 字符串。
 *
 * `completionOptionData` 是 expression-editor 里「补全项 → CM6 Completion 数据」的唯一映射点；
 * 单测锁三点：结构化 detail 走 i18n 格式化、detail 缺省时不写该字段、insertText 覆盖 apply。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { initI18n, setLocalePref } from '../../../src/i18n/index';
import { completionOptionData } from '../../../src/view/panels/expression-editor';
import type { CompletionDetail, ExprCompletion } from '../../../src/protocol/types';

beforeAll(async () => {
  await initI18n('zh-CN');
});

function item(detail?: CompletionDetail, insertText?: string): ExprCompletion {
  return {
    label: 'hotel_list',
    kind: 'field',
    ...(detail === undefined ? {} : { detail }),
    ...(insertText === undefined ? {} : { insertText }),
  };
}

describe('completionOptionData — 结构化 detail 本地化', () => {
  it('根字段 / 采样字段 / 属性 / 全局（中文逐字沿用旧 detail）', () => {
    expect(completionOptionData(item({ scope: 'root-field', kind: 'array' })).detail).toBe(
      '根字段 · array',
    );
    expect(
      completionOptionData(item({ scope: 'sampled-field', kind: 'mixed', freq: 3, samples: 10 }))
        .detail,
    ).toBe('混合 · 采样 3/10');
    expect(completionOptionData(item({ scope: 'property' })).detail).toBe('属性');
    expect(completionOptionData(item({ scope: 'global' })).detail).toBe('全局');
    expect(completionOptionData(item({ scope: 'math-method' })).detail).toBe('Math 方法');
  });

  it('detail 缺省 → 不写 detail 字段（CM6 得到 undefined，而不是空串）', () => {
    const option = completionOptionData(item());
    expect('detail' in option).toBe(false);
    expect(option.detail).toBeUndefined();
  });

  it('type / apply 映射：field → property，insertText 覆盖 label', () => {
    expect(completionOptionData(item(undefined, 'hotel_list[0]'))).toEqual({
      label: 'hotel_list',
      type: 'property',
      apply: 'hotel_list[0]',
    });
    expect(completionOptionData({ label: 'map', kind: 'method', detail: { scope: 'array-method' } })).toEqual({
      label: 'map',
      detail: 'array 方法',
      type: 'method',
      apply: 'map',
    });
  });

  it('切语言后重新映射即新语言（旧回包无需重发）', async () => {
    await setLocalePref('en-US');
    expect(completionOptionData(item({ scope: 'root-field', kind: 'object' })).detail).toBe(
      'root field · object',
    );
    await setLocalePref('zh-CN');
    expect(completionOptionData(item({ scope: 'root-field', kind: 'object' })).detail).toBe(
      '根字段 · object',
    );
  });
});
