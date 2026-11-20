/**
 * scripts/gen-icons.mjs — 生成扩展图标（16/32/48/128）的**唯一来源**。
 *
 *   node scripts/gen-icons.mjs            # 写到 src/app/icons/，再 node build.mjs 才会进 dist/
 *
 * 设计（2026-11-20 用户拍板，替代原先的一次性手工产物）：
 *   - 底板：靛蓝渐变圆角方（#6C79FF → #4450E4，圆角 = 22.5% 边长）。饱和底块让图标在
 *     深/浅两种工具栏上都自成一个亮块 —— 旧版「深色底 + 细括号」在深色工具栏里几乎看不见。
 *   - 标记：`{}` 画框（JSON 的成对记号，左右对称，不会读成「缺一半」）+ 中间一枚**涡轮盘**
 *     （`turbo` = 涡轮；实心盘挖三条带微弧的槽 + 小轮毂孔 = 「盘 + 三叶 + 轴」三层，
 *     比锥形槽版本少一层细节，16px 下每个元素仍有 2–3px 活动空间）。
 *   - 几何一律以 16 格为单位（u = 边长/16），16px 时一格 = 1 像素；不靠缩放 128 的图。
 *
 * 输出提交在仓库里（`build.mjs` 的 staticFiles 会把它拷进 `dist/icons`），本脚本只负责重画。
 * 依赖既有的 CfT harness（与冒烟脚本同一套），不引入新依赖。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { launchChrome, REPO_ROOT } from '../prototype/p1/lib/chrome.mjs';

const OUT = path.join(REPO_ROOT, 'src/app/icons');
const SIZES = [16, 32, 48, 128];

const chrome = await launchChrome({ windowSize: '800,600' });
try {
  const page = await chrome.openPage();
  await page.goto('about:blank', { timeoutMs: 15000 });

  const files = await page.eval(`(() => {
    const out = {};
    const u16 = (s) => s / 16;
    const CX = 8, CY = 8;

    const tile = (ctx, s) => {
      const g = ctx.createLinearGradient(0, 0, s * 0.7, s);
      g.addColorStop(0, '#6C79FF');
      g.addColorStop(1, '#4450E4');
      const r = s * 0.225;
      ctx.beginPath();
      ctx.moveTo(r, 0);
      ctx.arcTo(s, 0, s, s, r);
      ctx.arcTo(s, s, 0, s, r);
      ctx.arcTo(0, s, 0, 0, r);
      ctx.arcTo(0, 0, s, 0, r);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
    };

    // 花括号（16 格坐标）：stem = 竖干 x，spike = 中点尖端 x，flat = 端头 x
    const brace = (ctx, u, ink, stem, spike, top, bottom, w) => {
      const dir = stem < 8 ? 1 : -1;
      const flat = (stem + dir * 1.7) * u;
      const s = stem * u;
      const sp = spike * u;
      ctx.strokeStyle = ink;
      ctx.lineWidth = w * u;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(flat, top * u);
      ctx.quadraticCurveTo(s, top * u, s, (top + 1.7) * u);
      ctx.lineTo(s, 6.3 * u);
      ctx.quadraticCurveTo(s, 7.75 * u, sp, 8 * u);
      ctx.quadraticCurveTo(s, 8.25 * u, s, 9.7 * u);
      ctx.lineTo(s, (bottom - 1.7) * u);
      ctx.quadraticCurveTo(s, bottom * u, flat, bottom * u);
      ctx.stroke();
    };
    const brackets = (ctx, u, ink) => {
      brace(ctx, u, ink, 2.7, 1.2, 2.8, 13.2, 1.5);
      brace(ctx, u, ink, 13.3, 14.8, 2.8, 13.2, 1.5);
    };

    // 涡轮盘：实心圆挖三条带微弧的锥形槽（外宽内窄）+ 小轮毂孔。
    // 在离屏画布上用 destination-out 挖槽，再整体合成，槽里透出的是底板本身。
    const turbine = (ctx, s, u, ink, {
      slots = 3, rot = 0.18, wIn = 1.15, wOut = 2.35, spiral = 0.55, hub = 0.9, discR = 4.55,
    } = {}) => {
      const off = document.createElement('canvas');
      off.width = s;
      off.height = s;
      const o = off.getContext('2d');

      o.fillStyle = ink;
      o.beginPath();
      o.arc(CX * u, CY * u, discR * u, 0, Math.PI * 2);
      o.fill();

      o.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < slots; i++) {
        const a0 = rot + (i * 2 * Math.PI) / slots - Math.PI / 2;
        const pts = [];
        for (let k = 0; k <= 20; k++) {
          const t = k / 20;
          const a = a0 + t * spiral;
          const r = (1.0 + t * (discR - 0.35)) * u;
          pts.push([
            CX * u + Math.cos(a) * r,
            CY * u + Math.sin(a) * r,
            (wIn + t * (wOut - wIn)) * u,
          ]);
        }
        // 沿中心线法向两侧偏移成锥形槽（外宽内窄，缩小后圆边缘的缺口才留得住）
        const left = [];
        const right = [];
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          const q = pts[Math.min(k + 1, pts.length - 1)];
          const dx = q[0] - p[0];
          const dy = q[1] - p[1];
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          left.push([p[0] + (nx * p[2]) / 2, p[1] + (ny * p[2]) / 2]);
          right.push([p[0] - (nx * p[2]) / 2, p[1] - (ny * p[2]) / 2]);
        }
        o.beginPath();
        o.moveTo(left[0][0], left[0][1]);
        for (const p of left.slice(1)) o.lineTo(p[0], p[1]);
        for (const p of right.slice().reverse()) o.lineTo(p[0], p[1]);
        o.closePath();
        o.fill();
      }

      if (hub) {
        o.beginPath();
        o.arc(CX * u, CY * u, hub * u, 0, Math.PI * 2);
        o.fill();
      }

      ctx.drawImage(off, 0, 0);
    };

    const sizes = ${JSON.stringify(SIZES)};
    for (const s of sizes) {
      const u = u16(s);
      const c = document.createElement('canvas');
      c.width = s;
      c.height = s;
      const ctx = c.getContext('2d');
      tile(ctx, s);
      brackets(ctx, u, '#FFFFFF');
      turbine(ctx, s, u, '#FFFFFF');
      out['icon-' + s] = c.toDataURL('image/png');
    }
    return out;
  })()`);

  await mkdir(OUT, { recursive: true });
  for (const [name, dataUrl] of Object.entries(files)) {
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    await writeFile(path.join(OUT, `${name}.png`), Buffer.from(b64, 'base64'));
  }
  console.log(`icons written → ${OUT} (${SIZES.join('/')})`);
} finally {
  await chrome.close?.();
}
