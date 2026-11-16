/**
 * zh-CN — 简体中文语言包（按语言懒加载的分块，不内联进 page.js）。
 *
 * 完整性由类型守护：`Record<MessageKey, Message>`（缺 key / 多 key 都编译不过）。
 */
import type { Message } from '../../types';
import type { MessageKey } from '../en/pack';
import { app } from './app';
import { view } from './view';
import { core } from './core';

export const zhCN: Record<MessageKey, Message> = { ...app, ...view, ...core };
