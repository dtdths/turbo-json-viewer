/**
 * core/edit-history 单测 — 纯记账（不碰行模型）。
 *
 * 契约（#16 / ADR-0006）：
 *   apply(entry) → 入 undo 栈、截断 redo 分支、超 EDIT_UNDO_DEPTH 丢最旧；
 *   undo()/redo() 移动指针并返回「要应用的条目」（undo→oldValue、redo→newValue）；
 *   reset() 返回全部已生效条目（调用方 LIFO 反向应用）并清空；
 *   state() = { applied, canUndo, canRedo }。
 */
import { describe, expect, it } from 'vitest';
import { EditHistory } from '../../../src/core/edit-history';
import { EDIT_UNDO_DEPTH } from '../../../src/protocol/versions';

const entry = (n: number) => ({ path: `$.n${n}`, oldValue: n, newValue: n + 1 });

describe('EditHistory — 栈指针', () => {
  it('apply 后 applied=1、可撤销不可重做', () => {
    const h = new EditHistory();
    expect(h.state()).toEqual({ applied: 0, canUndo: false, canRedo: false });
    h.apply(entry(1));
    expect(h.state()).toEqual({ applied: 1, canUndo: true, canRedo: false });
  });

  it('undo 返回要应用的条目并左移指针；redo 返回同一条目并右移', () => {
    const h = new EditHistory();
    h.apply(entry(1));
    h.apply(entry(2));

    expect(h.undo()).toEqual(entry(2));
    expect(h.state()).toEqual({ applied: 1, canUndo: true, canRedo: true });
    expect(h.undo()).toEqual(entry(1));
    expect(h.state()).toEqual({ applied: 0, canUndo: false, canRedo: true });

    expect(h.redo()).toEqual(entry(1));
    expect(h.redo()).toEqual(entry(2));
    expect(h.state()).toEqual({ applied: 2, canUndo: true, canRedo: false });
  });

  it('栈端 no-op：空历史 undo / 满栈 redo 返回 null', () => {
    const h = new EditHistory();
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
    h.apply(entry(1));
    expect(h.redo()).toBeNull();
  });

  it('撤销后再 apply 会截断 redo 分支', () => {
    const h = new EditHistory();
    h.apply(entry(1));
    h.apply(entry(2));
    h.undo();
    expect(h.state().canRedo).toBe(true);

    h.apply(entry(3));
    expect(h.state()).toEqual({ applied: 2, canUndo: true, canRedo: false });
    // redo 栈已被丢弃，不能回到 entry(2)
    expect(h.redo()).toBeNull();
    expect(h.undo()).toEqual(entry(3));
  });
});

describe('EditHistory — 深度上限', () => {
  it(`超过 ${EDIT_UNDO_DEPTH} 条丢最旧，且最多撤销 ${EDIT_UNDO_DEPTH} 次`, () => {
    const h = new EditHistory();
    const total = EDIT_UNDO_DEPTH + 5;
    for (let i = 0; i < total; i++) h.apply(entry(i));

    expect(h.state()).toEqual({ applied: EDIT_UNDO_DEPTH, canUndo: true, canRedo: false });

    const undone: number[] = [];
    for (let i = 0; i < EDIT_UNDO_DEPTH; i++) undone.push(h.undo()?.oldValue as number);
    // 最新的先撤销，最旧的 5 条已被丢弃 → 最后撤销到 entry(5)
    expect(undone[0]).toBe(total - 1);
    expect(undone[undone.length - 1]).toBe(total - 1 - (EDIT_UNDO_DEPTH - 1));
    expect(h.undo()).toBeNull();
  });

  it('深度上限不破坏 redo 指针语义', () => {
    const h = new EditHistory();
    for (let i = 0; i < 3; i++) h.apply(entry(i));
    h.undo();
    h.undo();
    expect(h.state()).toEqual({ applied: 1, canUndo: true, canRedo: true });
    expect(h.redo()).toEqual(entry(1));
  });
});

describe('EditHistory — reset / clear', () => {
  it('reset 返回已生效条目（应用顺序）并清空；undo/redo 不可再走', () => {
    const h = new EditHistory();
    h.apply(entry(1));
    h.apply(entry(2));
    const applied = h.reset();
    expect(applied).toEqual([entry(1), entry(2)]);
    expect(h.state()).toEqual({ applied: 0, canUndo: false, canRedo: false });
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBeNull();
  });

  it('部分撤销后 reset 只返回仍生效的条目（redo 分支丢弃）', () => {
    const h = new EditHistory();
    h.apply(entry(1));
    h.apply(entry(2));
    h.undo(); // entry(2) 进入 redo 分支
    expect(h.reset()).toEqual([entry(1)]);
    expect(h.state().applied).toBe(0);
  });

  it('clear 清空全部状态', () => {
    const h = new EditHistory();
    h.apply(entry(1));
    h.clear();
    expect(h.state()).toEqual({ applied: 0, canUndo: false, canRedo: false });
    expect(h.undo()).toBeNull();
  });
});
