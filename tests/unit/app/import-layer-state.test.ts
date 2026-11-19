/**
 * tests/unit/app/import-layer-state — 入口层状态机的策略矩阵（#47 / ADR-0008 修订 2026-11-19）。
 *
 * 断言的是**策略**，不是 DOM：落点解析、满 8 降级/拒绝、丢弃确认、pending 两个落点、
 * busy/error 生命周期、关闭→收尾两个时点。渲染（文案 key → DOM）由 adapter + 冒烟覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  ImportLayerState,
  type LayerContext,
  type PendingImport,
} from '../../../src/app/import/layer-state';
import { CoreError } from '../../../src/protocol/errors';

/** 已打开一份文档、还能再开标签（默认场景）。 */
function ctx(overrides: Partial<LayerContext> = {}): LayerContext {
  return {
    hasDoc: true,
    importTarget: 'new-tab',
    canAddTab: true,
    maxTabs: 8,
    currentDoc: { name: 'a.json', bytes: 2048 },
    ...overrides,
  };
}

/** 「文档已打开、入口层已关」的常态（初始空态本身算 open，见状态机注释）。 */
function closedLayer(): ImportLayerState {
  const state = new ImportLayerState();
  state.close();
  return state;
}

const FILE_ENTRY: PendingImport = {
  kind: 'file',
  file: new File([JSON.stringify({ a: 1 })], 'dropped.json', { type: 'application/json' }),
};

describe('ImportLayerState — 初始态与 view 形态', () => {
  it('初始：initial 形态，没有 warn / target / pending，关闭钮不可见', () => {
    const state = new ImportLayerState();
    const view = state.view();
    expect(view.mode).toBe('initial');
    expect(view.titleKey).toBe('app.empty.title.initial');
    expect(view.subKey).toBe('app.empty.sub.initial');
    expect(view.warn).toBeNull();
    expect(view.hint).toBeNull();
    expect(view.target).toBeNull();
    expect(view.closeVisible).toBe(false);
    expect(view.pending).toBeNull();
    expect(view.busy).toBe(false);
    expect(view.error).toBeNull();
  });

  it('初始 state()：dev-hook 快照 5 个字段', () => {
    expect(new ImportLayerState().state()).toEqual({
      open: true,
      mode: 'initial',
      target: null,
      pendingName: null,
      limitNotice: false,
    });
  });
});

describe('ImportLayerState — open()：落点解析与满 8', () => {
  it('无文档时不开层（空工作区由空态导入，不走入口层）', () => {
    const state = closedLayer();
    expect(state.open(ctx({ hasDoc: false }))).toEqual({ kind: 'noop' });
    expect(state.isOpen()).toBe(false);
  });

  it('默认落点取设置 new-tab：打开 new-tab 形态，焦点进卡片', () => {
    const state = closedLayer();
    const result = state.open(ctx());
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(result.focus).toBe('inner');
    expect(result.view.mode).toBe('new-tab');
    expect(result.view.target).toBe('new-tab');
    expect(result.view.closeVisible).toBe(true);
  });

  it('默认落点 replace 且未确认：只出「需要丢弃确认」，层不打开', () => {
    const state = closedLayer();
    const result = state.open(ctx({ importTarget: 'replace' }));
    expect(result).toEqual({ kind: 'needs-discard-confirm' });
    expect(state.isOpen()).toBe(false);
  });

  it('确认后打开 replace 形态：覆盖警示带活动文档（名称 + 字节数）', () => {
    const state = closedLayer();
    const result = state.open(ctx({ importTarget: 'replace' }), undefined, true);
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(result.view.mode).toBe('replace');
    expect(result.view.warn).toEqual({ name: 'a.json', bytes: 2048 });
    expect(result.view.hint).toBeNull();
  });

  it('设置默认 new-tab 但满 8：自动降为 replace 并出说明（不是拒绝）', () => {
    const state = closedLayer();
    // 降到 replace 后仍要先过丢弃确认（与「默认 replace」同一条路径）
    const result = state.open(ctx({ canAddTab: false }), undefined, true);
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(result.view.mode).toBe('replace');
    expect(result.view.hint).toEqual({ n: 8 });
    expect(state.state().limitNotice).toBe(true);
  });

  it('显式请求 new-tab 且满 8：denied-limit（由 app 弹 toast，不静默改落点）', () => {
    const state = closedLayer();
    expect(state.open(ctx({ canAddTab: false }), 'new-tab')).toEqual({ kind: 'denied-limit' });
    expect(state.isOpen()).toBe(false);
  });

  it('层已打开时再 open：noop（不重开、不重置待确认载荷）', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    expect(state.open(ctx())).toEqual({ kind: 'noop' });
    expect(state.mode()).toBe('pending');
  });
});

describe('ImportLayerState — openNewTab()', () => {
  it('无文档：noop', () => {
    expect(closedLayer().openNewTab(ctx({ hasDoc: false }))).toEqual({ kind: 'noop' });
  });

  it('层已开且是 replace：切到 new-tab 并清错误', () => {
    const state = closedLayer();
    state.open(ctx({ importTarget: 'replace' }), undefined, true);
    state.setError(new CoreError({ code: 'PARSE', message: 'bad' }));
    const result = state.openNewTab(ctx());
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(result.view.mode).toBe('new-tab');
    expect(result.view.error).toBeNull();
  });

  it('层已开 pending：不切形态（落点由层内两个按钮决定）', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    expect(state.openNewTab(ctx())).toEqual({ kind: 'noop' });
    expect(state.mode()).toBe('pending');
  });

  it('层已开 replace 但满 8：denied-limit', () => {
    const state = closedLayer();
    state.open(ctx({ importTarget: 'replace' }), undefined, true);
    expect(state.openNewTab(ctx({ canAddTab: false }))).toEqual({ kind: 'denied-limit' });
  });

  it('层未开：等价于 open("new-tab")', () => {
    const state = closedLayer();
    const result = state.openNewTab(ctx());
    expect(result.kind).toBe('opened');
    expect(state.mode()).toBe('new-tab');
  });
});

describe('ImportLayerState — openPending() 与 choose()', () => {
  it('有文档：进入 pending 形态，条目 = 文件名 + 字节数', () => {
    const state = closedLayer();
    const result = state.openPending(ctx(), FILE_ENTRY);
    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(result.view.mode).toBe('pending');
    expect(result.view.pending?.name).toBe('dropped.json');
    expect(result.view.pending?.size).toBe(FILE_ENTRY.kind === 'file' ? FILE_ENTRY.file.size : -1);
    expect(result.view.target).toBeNull();
    expect(result.view.subKey).toBeNull();
  });

  it('焦点：能开新标签落「在新标签打开」，满 8 落到「替换当前文档」', () => {
    const canAdd = closedLayer();
    const r1 = canAdd.openPending(ctx(), FILE_ENTRY);
    expect(r1.kind === 'opened' && r1.focus).toBe('pendingNewTab');

    const full = closedLayer();
    const r2 = full.openPending(ctx({ canAddTab: false }), FILE_ENTRY);
    expect(r2.kind === 'opened' && r2.focus).toBe('pendingReplace');
  });

  it('文本载荷：size 按 UTF-8 字节数算（不按字符数）', () => {
    const state = closedLayer();
    const result = state.openPending(ctx(), { kind: 'text', text: '中文', name: 'paste' });
    expect(result.kind === 'opened' && result.view.pending?.size).toBe(6);
  });

  it('choose：未打开 / 非 pending / 无载荷时 noop', () => {
    const state = closedLayer();
    expect(state.choose('replace', ctx())).toEqual({ kind: 'noop' });
    state.open(ctx());
    expect(state.choose('replace', ctx())).toEqual({ kind: 'noop' });
  });

  it('choose("new-tab") 满 8：noop（按钮已禁用，事件不再改变状态）', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    expect(state.choose('new-tab', ctx({ canAddTab: false }))).toEqual({ kind: 'noop' });
  });

  it('choose("replace") 未确认：出「需要丢弃确认」；确认后出 import 载荷 + 落点', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    expect(state.choose('replace', ctx())).toEqual({
      kind: 'needs-discard-confirm',
      target: 'replace',
    });
    const confirmed = state.choose('replace', ctx(), true);
    expect(confirmed.kind).toBe('import');
    if (confirmed.kind !== 'import') return;
    expect(confirmed.target).toBe('replace');
    expect(confirmed.payload).toBe(FILE_ENTRY);
  });

  it('choose("new-tab") 不需要丢弃确认（非破坏性）', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    const result = state.choose('new-tab', ctx());
    expect(result.kind).toBe('import');
    if (result.kind !== 'import') return;
    expect(result.target).toBe('new-tab');
  });
});

describe('ImportLayerState — 落点切换 / busy / error / 关闭时点', () => {
  it('chooseTarget：replace ↔ new-tab 切换；target 随形态走', () => {
    const state = closedLayer();
    state.open(ctx({ importTarget: 'replace' }), undefined, true);
    expect(state.chooseTarget('new-tab', ctx())?.target).toBe('new-tab');
    expect(state.chooseTarget('replace', ctx())?.warn).toEqual({ name: 'a.json', bytes: 2048 });
  });

  it('chooseTarget：满 8 不能切到 new-tab；pending 形态不响应', () => {
    const state = closedLayer();
    state.open(ctx({ importTarget: 'replace' }), undefined, true);
    expect(state.chooseTarget('new-tab', ctx({ canAddTab: false }))).toBeNull();

    const pending = closedLayer();
    pending.openPending(ctx(), FILE_ENTRY);
    expect(pending.chooseTarget('replace', ctx())).toBeNull();
  });

  it('busy：view 反映；close 之后 isBusy 归零', () => {
    const state = closedLayer();
    state.open(ctx());
    expect(state.setBusy(true).busy).toBe(true);
    expect(state.isBusy()).toBe(true);
    state.close();
    expect(state.isBusy()).toBe(false);
  });

  it('busy：开始解析即清掉待确认条目（层内立即导入时）', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    const view = state.setBusy(true);
    expect(view.busy).toBe(true);
    expect(view.pending).toBeNull();
    expect(state.pendingImport()).toBeNull();
    expect(state.state().pendingName).toBeNull();
  });

  it('error：保留结构化错误（切语言重画同一 view 不重新格式化）', () => {
    const state = closedLayer();
    state.open(ctx());
    const error = new CoreError({ code: 'PARSE', message: 'bad', line: 3 });
    expect(state.setError(error).error).toBe(error);
    expect(state.view().error).toBe(error);
    expect(state.setError(null).error).toBeNull();
  });

  it('close()：立刻按已关闭处理，但形态保留给淡出画面', () => {
    const state = closedLayer();
    state.open(ctx());
    state.close();
    expect(state.isOpen()).toBe(false);
    expect(state.mode()).toBe('new-tab');
    expect(state.view().mode).toBe('new-tab');
  });

  it('settle()：复位成 initial，待确认载荷与错误清空', () => {
    const state = closedLayer();
    state.openPending(ctx(), FILE_ENTRY);
    state.setError(new CoreError({ code: 'PARSE', message: 'bad' }));
    state.close();
    const view = state.settle(ctx());
    expect(view.mode).toBe('initial');
    expect(view.pending).toBeNull();
    expect(view.error).toBeNull();
    expect(view.warn).toBeNull();
    expect(state.isOpen()).toBe(false);
    expect(state.state().pendingName).toBeNull();
  });

  it('showInitial()：回空态并显示（关掉最后一个标签）', () => {
    const state = closedLayer();
    state.open(ctx({ importTarget: 'replace' }), undefined, true);
    state.close();
    const view = state.showInitial(ctx({ hasDoc: false, currentDoc: null }));
    expect(view.mode).toBe('initial');
    expect(state.isOpen()).toBe(true);
    expect(state.mode()).toBe('initial');
  });
});
