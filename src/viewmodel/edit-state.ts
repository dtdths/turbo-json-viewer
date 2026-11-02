/**
 * viewmodel/edit-state — 临时修改状态（slice 5 / #16 / ADR-0006）。
 *
 * 纯 TS、零 DOM：把 core 的 `EditReply.history`（applied / canUndo / canRedo）
 * 映射成视图需要的派生状态（「已临时修改 N 处」徽标、undo/redo 可用性、dirty）。
 * 视图只订阅变化，不反向依赖 core。
 */
import type { EditHistoryState } from '../protocol/messages';

const EMPTY: EditHistoryState = { applied: 0, canUndo: false, canRedo: false };

export class EditState {
  private state: EditHistoryState = { ...EMPTY };
  private readonly listeners = new Set<() => void>();

  /** 从 EditReply.history 同步（undo/redo/reset/apply 后调用）；缺省视为 0/false。 */
  sync(state: EditHistoryState | undefined): void {
    const next = state ?? EMPTY;
    if (
      next.applied === this.state.applied &&
      next.canUndo === this.state.canUndo &&
      next.canRedo === this.state.canRedo
    ) {
      return;
    }
    this.state = { applied: next.applied, canUndo: next.canUndo, canRedo: next.canRedo };
    this.emit();
  }

  /** 文档重新加载 / 换根时清零（幂等）。 */
  clear(): void {
    this.sync(undefined);
  }

  get count(): number {
    return this.state.applied;
  }

  get canUndo(): boolean {
    return this.state.canUndo;
  }

  get canRedo(): boolean {
    return this.state.canRedo;
  }

  /** 有未重置的临时修改（导出时提示 `-edited` 用）。 */
  get dirty(): boolean {
    return this.state.applied > 0;
  }

  /** 返回退订函数；同一 fn 重复订阅按一次处理（Set 语义）。 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
