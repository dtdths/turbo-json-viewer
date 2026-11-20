import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DocSession } from '../../../src/app/doc-session';
import {
  ExpressionWorkspace,
  type ExpressionPanelPort,
  type ExpressionWorkspaceDeps,
} from '../../../src/app/expression-workspace';
import { initI18n } from '../../../src/i18n/index';
import type { EvalReply, EvalSuccess, ExprCompletion } from '../../../src/protocol/types';
import type { WindowSnapshot } from '../../../src/viewmodel/row-window-source';

/** 面板假件：只记最后一次设置，单测关心「模块让它显示什么」。 */
class FakePanel implements ExpressionPanelPort {
  text = '';
  strict = false;
  running = false;
  error: { message: string; line?: number; column?: number } | null = null;
  status = '';
  history: string[] = [];
  examples: readonly string[] = [];

  getText(): string {
    return this.text;
  }
  getStrict(): boolean {
    return this.strict;
  }
  setRunning(running: boolean): void {
    this.running = running;
  }
  setError(error: { message: string; line?: number; column?: number } | null): void {
    this.error = error;
  }
  setStatus(text: string): void {
    this.status = text;
  }
  addHistory(text: string): void {
    this.history.push(text);
  }
  setExamples(examples: readonly string[]): void {
    this.examples = examples;
  }
}

function success(overrides: Partial<EvalSuccess> = {}): EvalSuccess {
  return {
    ok: true,
    rootId: 'expr:1',
    docRevision: 1,
    rowVersion: 2,
    totalRows: 3,
    count: 3,
    kind: 'array',
    ms: 4,
    steps: 10,
    truncated: false,
    skipped: 0,
    ...overrides,
  };
}

interface Harness {
  expr: ExpressionWorkspace;
  session: DocSession;
  panel: FakePanel;
  deps: ExpressionWorkspaceDeps;
  bar: { shown: unknown[]; hidden: number };
  rows: { roots: unknown[]; requested: number; data: WindowSnapshot };
  tree: { scrolls: number[]; selected: string[] };
  view: {
    raw: boolean;
    treeMode: number;
    landings: unknown[];
    selections: (string | null)[];
    statusUpdates: number;
    focused: number;
    docPanel: number;
    jumps: string[];
    syncLocate: number;
  };
  core: {
    eval?: (req: unknown) => Promise<EvalReply>;
    complete?: (req: unknown) => Promise<{ items: ExprCompletion[] }>;
    locate?: (req: unknown) => Promise<{ path: string | null }>;
  };
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  toasts: { text: string; kind?: string }[];
  errors: unknown[];
  budget: 'loose' | 'standard' | 'strict';
  terminated: number;
  reloads: number;
}

function harness(overrides: Partial<{ selected: string | null; rows: WindowSnapshot }> = {}): Harness {
  const panel = new FakePanel();
  const session = new DocSession();
  session.restore({ rootId: 'doc:1', docRevision: 1, rowVersion: 1, totalRows: 10 });
  const bar = { shown: [] as unknown[], hidden: 0 };
  const rows = {
    roots: [] as unknown[],
    requested: 0,
    data:
      overrides.rows ??
      ({
        rootId: 'expr:1',
        rows: [{ path: '$[0]', originPath: '$.data.items[0]' }],
        totalRows: 1,
        start: 0,
        rowVersion: 2,
        stale: false,
        scrollTopPx: 0,
      } as unknown as WindowSnapshot),
  };
  const tree = { scrolls: [] as number[], selected: [] as string[] };
  const view = {
    raw: false,
    treeMode: 0,
    landings: [] as unknown[],
    selections: [] as (string | null)[],
    statusUpdates: 0,
    focused: 0,
    docPanel: 0,
    jumps: [] as string[],
    syncLocate: 0,
  };
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  const h: Harness = {
    expr: undefined as unknown as ExpressionWorkspace,
    session,
    panel,
    deps: undefined as unknown as ExpressionWorkspaceDeps,
    bar,
    rows,
    tree,
    view,
    core: {},
    storage,
    toasts: [],
    errors: [],
    budget: 'standard',
    terminated: 0,
    reloads: 0,
  };
  const deps: ExpressionWorkspaceDeps = {
    panel,
    bar: {
      show: (value) => bar.shown.push(value),
      hide: () => {
        bar.hidden += 1;
      },
    },
    session,
    rows: {
      setRoot: (next, opts) => rows.roots.push({ next, opts }),
      requestWindow: () => {
        rows.requested += 1;
      },
      snapshot: () => rows.data,
    },
    tree: {
      scrollToPx: (px) => tree.scrolls.push(px),
      setSelected: (path) => tree.selected.push(path as string),
    },
    core: {
      eval: (req) => (h.core.eval ? h.core.eval(req) : Promise.resolve(success())),
      complete: (req) => (h.core.complete ? h.core.complete(req) : Promise.resolve({ items: [] })),
      exprLocate: (req) =>
        h.core.locate ? h.core.locate(req) : Promise.resolve({ path: '$.data.items[0]' }),
    },
    shell: {
      land: (plan) => view.landings.push(plan),
      select: (path) => view.selections.push(path),
      syncLocateRaw: () => {
        view.syncLocate += 1;
      },
      updateStatus: () => {
        view.statusUpdates += 1;
      },
      focusTree: () => {
        view.focused += 1;
      },
      isRaw: () => view.raw,
      setTreeMode: () => {
        view.treeMode += 1;
      },
      setDocPanel: () => {
        view.docPanel += 1;
      },
      jumpToPath: async (path) => {
        view.jumps.push(path);
      },
      selected: () => overrides.selected ?? null,
    },
    budget: () => h.budget,
    terminate: () => {
      h.terminated += 1;
    },
    toast: (text, _ms, kind) => h.toasts.push({ text, kind }),
    error: (error) => h.errors.push(error),
    watchdogFlag: 'tjv.test.watchdog',
    storage,
    reload: () => {
      h.reloads += 1;
    },
  };
  h.deps = deps;
  h.expr = new ExpressionWorkspace(deps);
  return h;
}

/** 已经跑过一次结果的 harness（结果视图激活中）。 */
async function enteredHarness(): Promise<Harness> {
  const h = harness();
  await h.expr.run('$.data', false);
  return h;
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ExpressionWorkspace · 文档口径', () => {
  it('未进入结果视图时，文档根 / 版本直接取会话', () => {
    const h = harness();
    expect(h.expr.documentRootId()).toBe('doc:1');
    expect(h.expr.documentRevision()).toBe(1);
    expect(h.expr.activeRootId()).toBeNull();
  });

  it('结果视图激活时，文档根取进入前的存档（不是 expr 根）', async () => {
    const h = await enteredHarness();
    expect(h.expr.activeRootId()).toBe('expr:1');
    expect(h.session.rootId).toBe('expr:1');
    expect(h.expr.documentRootId()).toBe('doc:1');
    expect(h.expr.documentRevision()).toBe(1);
  });

  it('stale = 结果版本与文档版本不一致，且只在「非激活」时成立', async () => {
    const h = await enteredHarness();
    expect(h.expr.stale()).toBe(false);
    h.expr.back({ silent: true });
    expect(h.expr.stale()).toBe(false);
    // 文档被编辑推进版本
    h.session.restore({ rootId: 'doc:1', docRevision: 2, rowVersion: 5, totalRows: 12 });
    expect(h.expr.stale()).toBe(true);
    // 重新进入结果视图后不再是「stale banner」态（结果条按 stale 渲染由 enterFromArchive 传）
    h.expr.enterFromArchive();
    expect(h.expr.stale()).toBe(false);
  });
});

describe('ExpressionWorkspace · 进入 / 返回', () => {
  it('run 成功后：结果态、历史、状态行、结果条、落地计划都齐', async () => {
    const h = await enteredHarness();
    expect(h.expr.view?.rootId).toBe('expr:1');
    expect(h.expr.mirror.exprLastText.get()).toBe('$.data');
    expect(h.panel.history).toEqual(['$.data']);
    expect(h.panel.status).toContain('3');
    expect(h.expr.active).toBe(true);
    expect(h.bar.shown).toHaveLength(1);
    expect(h.view.landings).toHaveLength(1);
  });

  it('back 恢复文档会话、回顶、清选中、按 silent 决定焦点', async () => {
    const h = await enteredHarness();
    h.expr.back({ silent: true });
    expect(h.session.rootId).toBe('doc:1');
    expect(h.session.docRevision).toBe(1);
    expect(h.expr.active).toBe(false);
    expect(h.view.focused).toBe(0);
    expect(h.tree.scrolls.at(-1)).toBe(0);
    expect(h.tree.selected.at(-1)).toBeNull();

    const h2 = await enteredHarness();
    h2.expr.back();
    expect(h2.view.focused).toBe(1);
  });

  it('enterFromArchive 幂等：结果视图已激活时再进不会把存档覆盖成 expr 会话', async () => {
    const h = await enteredHarness();
    // 修复前：这里会把 docSessionBeforeExpr 覆盖成 expr 会话，返回后停在 expr 根
    h.expr.enterFromArchive();
    expect(h.expr.active).toBe(true);
    expect(h.expr.documentRootId()).toBe('doc:1');
    h.expr.back({ silent: true });
    expect(h.session.rootId).toBe('doc:1');
  });

  it('enterFromArchive 从原文视图进入时先切回树，并同步「在原文中定位」开关', async () => {
    const h = harness();
    h.view.raw = true;
    await h.expr.run('$.data');
    expect(h.view.treeMode).toBe(1);
    h.expr.back({ silent: true });
    h.view.syncLocate = 0;
    h.expr.enterFromArchive();
    expect(h.view.syncLocate).toBe(1);
  });

  it('enterFromArchive 按当前文档版本给结果条传 stale 标记', async () => {
    const h = await enteredHarness();
    h.expr.back({ silent: true });
    h.session.restore({ rootId: 'doc:1', docRevision: 9, rowVersion: 1, totalRows: 10 });
    h.bar.shown = [];
    h.expr.enterFromArchive();
    expect((h.bar.shown[0] as { stale: boolean }).stale).toBe(true);
  });

  it('resetTransient 只复位显示态，结果本体留在模块里（LRU 恢复用）', async () => {
    const h = await enteredHarness();
    h.expr.resetTransient();
    expect(h.expr.active).toBe(false);
    expect(h.expr.view?.rootId).toBe('expr:1');
    h.expr.enterFromArchive();
    expect(h.expr.active).toBe(true);
  });

  it('clear 连结果本体与行内反馈一起清', async () => {
    const h = await enteredHarness();
    h.expr.clear();
    expect(h.expr.view).toBeNull();
    expect(h.expr.active).toBe(false);
    expect(h.panel.running).toBe(false);
  });
});

describe('ExpressionWorkspace · 在途闸门', () => {
  it('cancel 后迟到的成功回包被丢弃（不写结果、不解 running 之外的东西）', async () => {
    const h = harness();
    let settle: (reply: EvalReply) => void = () => undefined;
    h.core.eval = () => new Promise<EvalReply>((resolve) => { settle = resolve; });
    const pending = h.expr.run('$.slow');
    expect(h.panel.running).toBe(true);
    h.expr.cancel();
    expect(h.panel.running).toBe(false);
    settle(success());
    await pending;
    expect(h.expr.view).toBeNull();
    expect(h.expr.active).toBe(false);
    expect(h.view.landings).toHaveLength(0);
  });

  it('running 期间再次 run 直接忽略（面板闸门）', async () => {
    const h = harness();
    let settle: (reply: EvalReply) => void = () => undefined;
    let calls = 0;
    h.core.eval = () => {
      calls += 1;
      return new Promise<EvalReply>((resolve) => { settle = resolve; });
    };
    const first = h.expr.run('$.a');
    const second = h.expr.run('$.b');
    expect(calls).toBe(1);
    settle(success());
    await Promise.all([first, second]);
  });

  it('空文本只清行内反馈，不发求值', async () => {
    const h = harness();
    let calls = 0;
    h.core.eval = () => {
      calls += 1;
      return Promise.resolve(success());
    };
    await h.expr.run('   ');
    expect(calls).toBe(0);
    expect(h.panel.error).toBeNull();
    expect(h.panel.status).toBe('');
  });

  it('无文档时提示且不进入结果视图', async () => {
    const h = harness();
    h.session.restore({ rootId: null, docRevision: 0, rowVersion: 0, totalRows: 0 });
    await h.expr.run('$.a');
    expect(h.toasts).toHaveLength(1);
    expect(h.expr.active).toBe(false);
  });

  it('引擎错误只作用于输入，保留上一份结果', async () => {
    const h = await enteredHarness();
    const before = h.expr.view;
    h.core.eval = () =>
      Promise.resolve({ ok: false, error: { code: 'PARSE_ERR_SYNTAX', line: 1, column: 3 } });
    await h.expr.run('$.broken');
    expect(h.expr.view).toBe(before);
    expect(h.panel.error?.line).toBe(1);
    expect(h.panel.status).toBe('');
  });

  it('watchdog：到点终止 worker + 重载，回包不再落地', async () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.budget = 'strict';
      h.core.eval = () => new Promise<EvalReply>(() => undefined);
      const pending = h.expr.run('$.stuck');
      await vi.advanceTimersByTimeAsync(6_000);
      await pending;
      expect(h.terminated).toBe(1);
      expect(h.reloads).toBe(1);
      expect(h.expr.view).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ExpressionWorkspace · watchdog 标记', () => {
  it('watchdog 触发时先写重载标记，再终止并重载', () => {
    vi.useFakeTimers();
    try {
      const h = harness();
      h.budget = 'strict';
      h.core.eval = () => new Promise<EvalReply>(() => undefined);
      void h.expr.run('$.stuck');
      vi.advanceTimersByTime(6_000);
      expect(h.storage.getItem('tjv.test.watchdog')).toBe('1');
      expect(h.terminated).toBe(1);
      expect(h.reloads).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('consumeWatchdogFlag：有标记 → 提示并清掉；无标记 → 安静', () => {
    const h = harness();
    h.expr.consumeWatchdogFlag();
    expect(h.toasts).toHaveLength(0);
    h.storage.setItem('tjv.test.watchdog', '1');
    h.expr.consumeWatchdogFlag();
    expect(h.toasts).toHaveLength(1);
    expect(h.storage.getItem('tjv.test.watchdog')).toBeNull();
  });
});

describe('ExpressionWorkspace · 版本扇出与行内反馈', () => {
  it('syncVersions 同时更新文档会话存档与结果视图', async () => {
    const h = await enteredHarness();
    h.expr.syncVersions([
      { rootId: 'doc:1', rowVersion: 7, totalRows: 11 },
      { rootId: 'expr:1', rowVersion: 9, totalRows: 4 },
    ]);
    expect(h.expr.documentRevision()).toBe(1);
    expect(h.expr.view?.rowVersion).toBe(9);
    expect(h.expr.view?.totalRows).toBe(4);
    h.expr.back({ silent: true });
    expect(h.session.rowVersion).toBe(7);
    expect(h.session.totalRows).toBe(11);
  });

  it('syncLandedRoot 只写当前激活的结果根', async () => {
    const h = await enteredHarness();
    h.expr.syncLandedRoot({ rootId: 'expr:2', rowVersion: 50, totalRows: 60 });
    expect(h.expr.view?.rowVersion).toBe(2);
    h.expr.syncLandedRoot({ rootId: 'expr:1', rowVersion: 3, totalRows: 30 });
    expect(h.expr.view?.rowVersion).toBe(3);
    expect(h.expr.view?.totalRows).toBe(30);
  });

  it('applyInlineText 按当前错误 / 状态重新本地化', async () => {
    const h = await enteredHarness();
    h.panel.status = '';
    h.panel.error = null;
    h.expr.applyInlineText();
    expect(h.panel.status).toContain('3');
  });
});

describe('ExpressionWorkspace · 原路径 / 跳转 / 补全 / 示例', () => {
  it('refreshOrigin 记录 originPath；计算值为 null；离开结果视图清掉', async () => {
    const h = harness({ selected: '$[0]' });
    await h.expr.run('$.data');
    h.expr.refreshOrigin();
    expect(h.expr.selectedOrigin).toEqual({ rootId: 'expr:1', path: '$[0]', origin: '$.data.items[0]' });
    h.expr.back({ silent: true });
    expect(h.expr.selectedOrigin).toBeNull();
  });

  it('jumpFromRow：有来源 → 返回文档树并跳转；无来源 → 提示且不跳', async () => {
    const h = await enteredHarness();
    await h.expr.jumpFromRow('$[0]');
    expect(h.expr.active).toBe(false);
    expect(h.view.docPanel).toBe(1);
    expect(h.view.jumps).toEqual(['$.data.items[0]']);

    const h2 = await enteredHarness();
    h2.core.locate = () => Promise.resolve({ path: null });
    await h2.expr.jumpFromRow('$[0]');
    expect(h2.toasts).toHaveLength(1);
    expect(h2.view.jumps).toHaveLength(0);
  });

  it('补全异常降级为空列表', async () => {
    const h = harness();
    h.core.complete = () => Promise.reject(new Error('boom'));
    expect(await h.expr.completions('$.', 2)).toEqual([]);
  });

  it('示例：无文档只给 2 条通用；有文档给 3 条动态（首个数组字段走 filter）+ 2 条通用', async () => {
    const h = harness();
    h.session.restore({ rootId: null, docRevision: 0, rowVersion: 0, totalRows: 0 });
    expect(await h.expr.examples()).toHaveLength(2);
    h.session.restore({ rootId: 'doc:1', docRevision: 1, rowVersion: 1, totalRows: 10 });
    h.core.complete = () =>
      Promise.resolve({
        items: [
          { label: 'items', kind: 'field', detail: { scope: 'root-field', kind: 'array' } },
          { label: 'meta', kind: 'field', detail: { scope: 'root-field', kind: 'object' } },
          { label: 'name', kind: 'field', detail: { scope: 'root-field', kind: 'string' } },
          { label: 'extra', kind: 'field' },
        ] as ExprCompletion[],
      });
    const items = await h.expr.examples();
    expect(items).toEqual(['$.items.filter(x => x !== null)', '$.meta', '$.name', expect.any(String), expect.any(String)]);
  });
});
