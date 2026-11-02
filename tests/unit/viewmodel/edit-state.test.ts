import { describe, expect, it } from 'vitest';
import { EditState } from '../../../src/viewmodel/edit-state';

describe('EditState — 初始状态', () => {
  it('未编辑：count 0 / canUndo false / canRedo false / 不是 dirty', () => {
    const state = new EditState();
    expect(state.count).toBe(0);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.dirty).toBe(false);
  });
});

describe('EditState — 同步编辑历史', () => {
  it('sync 更新 count/canUndo/canRedo/dirty，并通知订阅者', () => {
    const state = new EditState();
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });

    state.sync({ applied: 2, canUndo: true, canRedo: false });

    expect(state.count).toBe(2);
    expect(state.canUndo).toBe(true);
    expect(state.canRedo).toBe(false);
    expect(state.dirty).toBe(true);
    expect(notified).toBe(1);
  });

  it('值未变化时不再通知（重复 sync 同一回包 / undo 到底）', () => {
    const state = new EditState();
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });

    state.sync({ applied: 1, canUndo: false, canRedo: true });
    expect(notified).toBe(1);
    state.sync({ applied: 1, canUndo: false, canRedo: true });
    expect(notified).toBe(1);

    // 任一字段变化 → 通知
    state.sync({ applied: 1, canUndo: true, canRedo: false });
    expect(notified).toBe(2);
  });

  it('clear 归零并通知；再次 clear 幂等不通知', () => {
    const state = new EditState();
    let notified = 0;
    state.subscribe(() => {
      notified += 1;
    });

    state.sync({ applied: 3, canUndo: true, canRedo: false });
    expect(notified).toBe(1);

    state.clear();
    expect(state.count).toBe(0);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.dirty).toBe(false);
    expect(notified).toBe(2);

    state.clear();
    expect(notified).toBe(2);
  });

  it('sync(undefined) 视为清零（新文档没有 history 字段）', () => {
    const state = new EditState();
    state.sync({ applied: 1, canUndo: true, canRedo: false });

    state.sync(undefined);

    expect(state.count).toBe(0);
    expect(state.canUndo).toBe(false);
    expect(state.dirty).toBe(false);
  });

  it('退订后不再收到通知；重复退订安全', () => {
    const state = new EditState();
    let a = 0;
    let b = 0;
    const offA = state.subscribe(() => {
      a += 1;
    });
    state.subscribe(() => {
      b += 1;
    });

    offA();
    offA();
    state.sync({ applied: 1, canUndo: true, canRedo: false });

    expect(a).toBe(0);
    expect(b).toBe(1);
  });

  it('sync 后外部改写传入对象不影响内部状态（防御性拷贝）', () => {
    const state = new EditState();
    const input = { applied: 1, canUndo: true, canRedo: false };
    state.sync(input);

    input.applied = 99;
    expect(state.count).toBe(1);
  });
});
