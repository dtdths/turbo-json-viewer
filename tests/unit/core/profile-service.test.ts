import { describe, expect, it, vi } from 'vitest';

/**
 * 回填 `nodeCountCache`（ADR-0025 §3）是**可观测行为**：`profile` 之后首次 eval
 * 不应再调用 `countDocumentNodes`。这里只包一层计数外层，其余仍走真实引擎。
 */
const countCalls = vi.hoisted(() => ({ value: 0 }));
vi.mock('../../../src/core/expression/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/core/expression/engine')>();
  return {
    ...actual,
    countDocumentNodes: (root: unknown) => {
      countCalls.value += 1;
      return actual.countDocumentNodes(root);
    },
  };
});

import { DocService } from '../../../src/core/doc-service';
import { CoreError } from '../../../src/protocol/errors';
import type { LoadReply } from '../../../src/protocol/messages';
import type { CompleteReply, DocumentProfile } from '../../../src/protocol/types';

const ITEMS_DOC = { items: [{ name: 'a', price: 1 }, { name: 'b', price: 2 }], meta: { v: 1 } };
const ITEMS_TEXT = JSON.stringify(ITEMS_DOC);

async function errorOf(promise: Promise<unknown>): Promise<CoreError> {
  try {
    await promise;
  } catch (err) {
    if (!(err instanceof CoreError)) throw err;
    return err;
  }
  throw new Error('expected the command to reject');
}

async function load(svc: DocService, data: string = ITEMS_TEXT, loadId = 1): Promise<LoadReply> {
  return svc.dispatch({ t: 'load', loadId, source: 'paste', data, name: 'doc.json' });
}

const profileOf = (svc: DocService, rootId: string): Promise<DocumentProfile> =>
  svc.dispatch({ t: 'profile', rootId });

const completeOf = (svc: DocService, rootId: string, text: string): Promise<CompleteReply> =>
  svc.dispatch({ t: 'complete', rootId, text, pos: text.length });

/* ------------------------------ profile 命令 ------------------------------ */

describe('DocService.profile — 契约（ADR-0025 §3/§5）', () => {
  it('文档根返回真实采样；nodeCount 回显文档节点数', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    const profile = await profileOf(svc, loaded.rootId);
    expect(profile).toMatchObject({
      rootKind: 'object',
      nodeCount: 10,
      maxDepth: 4,
      sampled: false,
      sampledNodes: 10,
      truncated: false,
    });
    expect(profile.paths[0]).toEqual({
      segments: [],
      kind: 'object',
      samples: 1,
      members: [
        { name: 'items', freq: 1, kind: 'array' },
        { name: 'meta', freq: 1, kind: 'object' },
      ],
    });
    expect(profile.paths.map((sample) => sample.segments.join('.'))).toEqual(['', 'items', 'meta']);
  });

  it('按 (rootId, docRevision) 缓存：同版本重复调用结果一致', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    const first = await profileOf(svc, loaded.rootId);
    const second = await profileOf(svc, loaded.rootId);
    expect(second).toEqual(first);
  });

  it('只读：profile 不推 docRevision / rowVersion', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    const before = await svc.dispatch({ t: 'stats', rootId: loaded.rootId });
    await profileOf(svc, loaded.rootId);
    expect(await svc.dispatch({ t: 'stats', rootId: loaded.rootId })).toEqual(before);
  });

  it('编辑推进 docRevision → 缓存失效、按新值图重采', async () => {
    const svc = new DocService();
    const loaded = await load(svc, JSON.stringify({ n: 1 }));
    expect((await profileOf(svc, loaded.rootId)).nodeCount).toBe(2);

    const edited = await svc.dispatch({
      t: 'replaceNode',
      rootId: loaded.rootId,
      path: '$',
      docRevision: loaded.docRevision,
      jsonText: JSON.stringify({ n: { a: 1 }, m: 2 }),
    });
    expect(edited.docRevision).toBe(loaded.docRevision + 1);

    const profile = await profileOf(svc, loaded.rootId);
    expect(profile.nodeCount).toBe(4);
    expect(profile.maxDepth).toBe(3);
    expect(profile.paths.map((sample) => sample.segments.join('.'))).toEqual(['', 'n']);
  });

  it('表达式根 → BAD_COMMAND（与 complete 同口径）；未知根 → NO_ROOT', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    const evaluated = await svc.dispatch({
      t: 'eval',
      rootId: loaded.rootId,
      seq: 1,
      text: '$.items',
      strict: false,
      budget: 'standard',
    });
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;

    const profileErr = await errorOf(profileOf(svc, evaluated.rootId));
    expect(profileErr.code).toBe('BAD_COMMAND');
    expect(profileErr.message).toContain('document root');

    const completeErr = await errorOf(completeOf(svc, evaluated.rootId, '$.'));
    expect(completeErr.code).toBe('BAD_COMMAND');

    expect((await errorOf(profileOf(svc, 'doc:999'))).code).toBe('NO_ROOT');
  });

  it('closeRoot 清缓存条目（白盒：旁路缓存随根释放）', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    await profileOf(svc, loaded.rootId);

    // 白盒访问：profile 缓存是 doc-service 的旁路状态，与 nodeCountCache 同处清理（ADR-0025 §8）
    const internals = svc as unknown as { profileCache: Map<string, unknown> };
    expect(internals.profileCache.size).toBe(1);

    expect(await svc.dispatch({ t: 'closeRoot', rootId: loaded.rootId })).toEqual({
      rootId: loaded.rootId,
      closed: true,
    });
    expect(internals.profileCache.size).toBe(0);
    expect((await errorOf(profileOf(svc, loaded.rootId))).code).toBe('NO_ROOT');
  });
});

/* ------------------------- nodeCountCache 回填（一次采样两处用） ------------------------- */

describe('DocService.profile — 回填 nodeCountCache（表达式首次求值不重复遍历）', () => {
  it('先 profile 再 eval：countDocumentNodes 不再被调用', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    await profileOf(svc, loaded.rootId);
    countCalls.value = 0;

    const evaluated = await svc.dispatch({
      t: 'eval',
      rootId: loaded.rootId,
      seq: 1,
      text: '$.meta.v',
      strict: false,
      budget: 'standard',
    });
    expect(evaluated.ok).toBe(true);
    expect(countCalls.value).toBe(0);
  });

  it('对照：未采样时 eval 惰性计数一次', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    countCalls.value = 0;

    const evaluated = await svc.dispatch({
      t: 'eval',
      rootId: loaded.rootId,
      seq: 1,
      text: '$.meta.v',
      strict: false,
      budget: 'standard',
    });
    expect(evaluated.ok).toBe(true);
    expect(countCalls.value).toBe(1);
  });
});

/* ------------------------------ complete 消费 profile ------------------------------ */

describe('DocService.complete — 从缓存 profile 拼补全上下文（ADR-0025 §6）', () => {
  it('profile 未就绪 → 退化为现有行为（items. 只有方法并集）', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    const reply = await completeOf(svc, loaded.rootId, 'items.');
    const labels = reply.items.map((item) => item.label);
    expect(labels).toContain('map');
    expect(labels).toContain('length');
    expect(labels).not.toContain('name');
  });

  it('profile 就绪 → items. 给真实元素字段（detail = `<kind> · 采样 <freq>/<samples>`）', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    await profileOf(svc, loaded.rootId);

    const items = await completeOf(svc, loaded.rootId, 'items.');
    // 数组路径：元素字段在前，随后追加数组方法并集（ADR-0025 §6 修订：既有能力不回归）
    expect(items.items.map((item) => item.label).slice(0, 2)).toEqual(['name', 'price']);
    expect(items.items.map((item) => item.label)).toContain('map');
    expect(items.items[0]).toMatchObject({ kind: 'field', detail: 'string · 采样 2/2' });
    expect(items.items[1]).toMatchObject({ kind: 'field', detail: 'number · 采样 2/2' });

    // 任意深纯键链：$.meta.
    const meta = await completeOf(svc, loaded.rootId, '$.meta.');
    expect(meta.items.map((item) => item.label)).toEqual(['v']);
    expect(meta.items[0]).toMatchObject({ kind: 'field', detail: 'number · 采样 1/1' });
  });

  it('根级补全保持「根字段 · <kind>」detail（main.ts 动态示例依赖）', async () => {
    const svc = new DocService();
    const loaded = await load(svc);
    await profileOf(svc, loaded.rootId);
    const reply = await completeOf(svc, loaded.rootId, '');
    const items = reply.items.find((item) => item.label === 'items');
    const meta = reply.items.find((item) => item.label === 'meta');
    expect(items).toMatchObject({ kind: 'field', detail: '根字段 · array' });
    expect(meta).toMatchObject({ kind: 'field', detail: '根字段 · object' });
  });
});
