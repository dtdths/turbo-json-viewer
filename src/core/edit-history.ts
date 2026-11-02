/**
 * core/edit-history — 编辑历史的**纯记账**（不碰行模型 / 值图）。
 *
 * 语义见 ADR-0006 / `docs/design/edit-spec.md` §5：
 *   - 每次 mutation 记 `{ path, oldValue, newValue }`；undo 用 oldValue 反向 replace，redo 用 newValue；
 *   - 栈深 `EDIT_UNDO_DEPTH`（100），超限丢**最旧**；
 *   - 在历史中撤销后再 apply → 截断 redo 分支；
 *   - `reset()` 返回全部**已生效**条目（调用方按 LIFO 反向应用 oldValue）并清空历史。
 *
 * 这里只管指针与条目，不知道 RowModel / DocService 的存在：行模型与版本号由 DocService 负责。
 */
import type { EditHistoryState } from '../protocol/messages';
import { EDIT_UNDO_DEPTH } from '../protocol/versions';
import type { Path } from '../protocol/types';

export interface EditEntry {
  path: Path;
  /** 替换前的值（undo 用） */
  oldValue: unknown;
  /** 替换后的值（redo 用） */
  newValue: unknown;
}

export class EditHistory {
  /** 按应用顺序排列的条目；`[0, applied)` 是已生效部分，其余是 redo 分支 */
  private entries: EditEntry[] = [];
  private appliedCount = 0;

  /** 记录一次已生效的 mutation：丢弃 redo 分支、入栈、按上限丢最旧。 */
  apply(entry: EditEntry): void {
    // 撤销后再编辑：redo 分支作废
    this.entries.length = this.appliedCount;
    this.entries.push(entry);
    const overflow = this.entries.length - EDIT_UNDO_DEPTH;
    if (overflow > 0) this.entries.splice(0, overflow);
    this.appliedCount = this.entries.length;
  }

  /** 撤销一步；返回**要应用的条目**（调用方用 oldValue 反向替换），无可撤销时 null。 */
  undo(): EditEntry | null {
    if (this.appliedCount === 0) return null;
    this.appliedCount -= 1;
    return this.entries[this.appliedCount] as EditEntry;
  }

  /** 重做一步；返回要应用的条目（调用方用 newValue 正向替换），无可重做时 null。 */
  redo(): EditEntry | null {
    if (this.appliedCount >= this.entries.length) return null;
    const entry = this.entries[this.appliedCount] as EditEntry;
    this.appliedCount += 1;
    return entry;
  }

  /**
   * 丢弃全部编辑：返回**仍生效**的条目（应用顺序，调用方需 LIFO 反向应用 oldValue），随后清空。
   * 已撤销的 redo 分支不返回（它们本就未生效）。
   */
  reset(): EditEntry[] {
    const applied = this.entries.slice(0, this.appliedCount);
    this.clear();
    return applied;
  }

  state(): EditHistoryState {
    return {
      applied: this.appliedCount,
      canUndo: this.appliedCount > 0,
      canRedo: this.appliedCount < this.entries.length,
    };
  }

  clear(): void {
    this.entries = [];
    this.appliedCount = 0;
  }
}
