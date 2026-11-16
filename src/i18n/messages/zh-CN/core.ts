/**
 * zh-CN/core — worker 诊断文案的中文词条（与 `en/core.ts` 键集一一对应）。
 */
import type { Message } from '../../types';
import type { CoreMessages } from '../en/core';

export const core: Record<keyof CoreMessages, Message> = {
  'core.listSeparator': '、',

  /* ---------------- 修复：逐条 note ---------------- */
  'core.repair.note.trailingComma': '尾随逗号 → 删除',
  'core.repair.note.memberNoValue': '键名未写完且没有值可保留 → 丢弃整个成员（不补引号）',
  'core.repair.note.escapeHalf': '末尾是不完整转义 → 丢弃（不猜测字符）',
  'core.repair.note.stringUnclosed': '字符串未闭合 → 补结束引号',
  'core.repair.note.literalPartial': '不完整字面量 `{literal}` → 丢弃（不猜测 true/false/null）',
  'core.repair.note.numberDropped': '不完整数字 `{literal}` → 整段丢弃（没有合法前缀可保留）',
  'core.repair.note.numberPrefix': '不完整数字 `{literal}` → 只保留合法前缀 `{keep}`（不补数字）',
  'core.repair.note.keyNoValue': '键已闭合但后面没有值 → 删除该键（不补值、不猜冒号）',
  'core.repair.note.danglingKey': '悬空的键（后面没有值）→ 连同冒号删除',
  'core.repair.note.closers': {
    one: '补 {n} 个闭合符 `{closers}`（对应未闭合的 {where}）',
    other: '补 {n} 个闭合符 `{closers}`（对应未闭合的 {where}）',
  },

  /* ---------------- 修复：一行摘要 ---------------- */
  'core.repair.summary.deletedChars': {
    one: '删除 {count} 个字符',
    other: '删除 {count} 个字符',
  },
  'core.repair.summary.bracket': {
    one: '{count} 个闭合符',
    other: '{count} 个闭合符',
  },
  'core.repair.summary.quote': {
    one: '{count} 个结束引号',
    other: '{count} 个结束引号',
  },
  /** 闭合符/结束引号合并成一组，统一加前缀（旧文案「补 6 个闭合符、1 个结束引号」） */
  'core.repair.summary.closes': '补 {list}',
  'core.repair.summary.repaired': '已修复：{bits}（仅语法闭合，未修改任何已有值）',
  'core.repair.summary.repairedNone': '已修复（仅语法闭合，未修改任何已有值）',

  /* ---------------- 搜索：正则不可用 ---------------- */
  'core.pattern.syntax': '正则语法错误：{reason}',
  'core.pattern.tooLong': '正则过长（上限 {n} 字符）',
  'core.pattern.backtracking': '该正则可能触发灾难性回溯',

  /* ---------------- 补全：detail ---------------- */
  'core.complete.kind.mixed': '混合',
  'core.complete.detail.sampled': '{kind} · 采样 {freq}/{samples}',
  'core.complete.detail.rootField': '根字段 · {kind}',
  'core.complete.detail.rootFieldPlain': '根字段',
  'core.complete.detail.global': '全局',
  'core.complete.detail.mathMethod': 'Math 方法',
  'core.complete.detail.arrayMethod': 'array 方法',
  'core.complete.detail.stringMethod': 'string 方法',
  'core.complete.detail.jsonMethod': 'JSON 方法',
  'core.complete.detail.property': '属性',
};
