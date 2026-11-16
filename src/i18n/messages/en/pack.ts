/**
 * en — 英文语言包（**真相源**；按语言懒加载，不内联进 page.js）。
 *
 * 语言分层：`app.*`（外壳）/ `view.*`（视图组件）/ `core.*`（worker 诊断的页面侧格式化）。
 * `MessageKey` 由本文件推导——新增 key 时所有语言包都必须补齐（`zh-CN/pack.ts` 有类型守护）。
 */
import { app } from './app';
import { view } from './view';
import { core } from './core';

export const en = { ...app, ...view, ...core } as const;

export type MessageKey = keyof typeof en;
