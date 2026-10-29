/* ==========================================================================
   JSON map (canvas path tower) — Direction A
   A small, DPR-aware "where am I" map: root → current path, plus a tick strip
   showing the current level's neighbouring keys. Purely visual prototype.
   ========================================================================== */
(function () {
  'use strict';

  var MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, monospace';

  var TRAIL = {
    levels: [
      { key: 'root', kind: 'object' },
      { key: 'data', kind: 'object' },
      { key: 'hotel_list', kind: 'array', index: 1234, count: 5000 },
      { key: 'rooms', kind: 'array', index: 5, count: 12 }
    ],
    current: { key: 'price', kind: 'number', preview: '2380' },
    siblings: [
      { key: 'type', kind: 'string' },
      { key: 'base_price', kind: 'number' },
      { key: 'price', kind: 'number', current: true },
      { key: 'area', kind: 'number' },
      { key: 'breakfast', kind: 'boolean' }
    ]
  };

  function readVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function palette() {
    return {
      text: readVar('--text-2'),
      muted: readVar('--muted'),
      faint: readVar('--faint'),
      accent: readVar('--accent'),
      accentText: readVar('--accent-text'),
      accentSoft: readVar('--accent-soft'),
      border: readVar('--border'),
      borderSubtle: readVar('--border-subtle'),
      borderStrong: readVar('--border-strong'),
      key: readVar('--syntax-key'),
      string: readVar('--syntax-string'),
      number: readVar('--syntax-number'),
      boolean: readVar('--syntax-boolean'),
      nul: readVar('--syntax-null')
    };
  }

  function kindColor(kind, p) {
    switch (kind) {
      case 'string': return p.string;
      case 'number': return p.number;
      case 'boolean': return p.boolean;
      case 'null': return p.nul;
      default: return p.key;
    }
  }

  function ellipsize(ctx, text, max) {
    if (ctx.measureText(text).width <= max) return text;
    var t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  function roundRect(ctx, x, y, w, h, r) {
    var rr = Math.min(r, h / 2, w / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function draw(canvas, trail) {
    if (!canvas) return;
    trail = trail || TRAIL;

    var rect = canvas.getBoundingClientRect();
    var W = Math.round(rect.width);
    var H = Math.round(rect.height);
    if (!W || !H) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    var ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var p = palette();
    var padL = 12;
    var padR = 12;
    var top = 6;
    var rowH = 20;
    var levels = trail.levels;
    var curIndex = levels.length;
    var totalRows = levels.length + 1;
    var centerY = function (i) { return top + i * rowH + rowH / 2; };

    // guides + ancestor rows
    for (var i = 0; i < levels.length; i++) {
      var lv = levels[i];
      var baseX = padL + i * 10;
      var cy = centerY(i);

      if (i > 0) {
        var gx = baseX - 6;
        ctx.strokeStyle = p.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gx + 0.5, centerY(i - 1));
        ctx.lineTo(gx + 0.5, cy);
        ctx.lineTo(baseX - 1, cy);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.fillStyle = kindColor(lv.kind, p);
      ctx.globalAlpha = lv.kind === 'object' || lv.kind === 'array' ? 0.7 : 0.95;
      ctx.arc(baseX + 1, cy, 1.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      var keyX = baseX + 8;
      var keyColor = i === levels.length - 1 ? p.text : p.key;
      ctx.font = '11px ' + MONO;
      ctx.fillStyle = keyColor;
      ctx.textBaseline = 'middle';
      ctx.fillText(lv.key, keyX, cy + 0.5);
      var kw = ctx.measureText(lv.key).width;

      if (lv.kind === 'array' && typeof lv.count === 'number') {
        var arr = '[' + lv.index + '/' + lv.count + ']';
        ctx.font = '10px ' + MONO;
        ctx.fillStyle = p.faint;
        ctx.fillText(arr, keyX + kw + 6, cy + 1);
      }
    }

    // current node row
    var cur = trail.current;
    var curY = centerY(curIndex);
    var rowX = 5;
    var rowW = W - 10;

    roundRect(ctx, rowX, curY - rowH / 2 + 1, rowW, rowH - 2, 5);
    ctx.fillStyle = p.accentSoft;
    ctx.fill();
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = p.accent;
    roundRect(ctx, rowX, curY - rowH / 2 + 1, 2.5, rowH - 2, 1.5);
    ctx.fill();

    var curBaseX = padL + curIndex * 10;
    var gx2 = curBaseX - 6;
    ctx.strokeStyle = p.accent;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(gx2 + 0.5, centerY(curIndex - 1));
    ctx.lineTo(gx2 + 0.5, curY);
    ctx.lineTo(curBaseX - 1, curY);
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.fillStyle = p.accent;
    ctx.arc(curBaseX + 1, curY, 2, 0, Math.PI * 2);
    ctx.fill();

    var curKeyX = curBaseX + 8;
    ctx.font = '11px ' + MONO;
    ctx.fillStyle = p.accentText;
    ctx.textBaseline = 'middle';
    ctx.fillText(cur.key, curKeyX, curY + 0.5);
    var curKeyW = ctx.measureText(cur.key).width;

    // ◉ marker (current position)
    if (curKeyW + 16 < rowW - 46) {
      ctx.beginPath();
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.2;
      ctx.arc(curKeyX + curKeyW + 8, curY, 3.4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.fillStyle = p.accent;
      ctx.arc(curKeyX + curKeyW + 8, curY, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }

    if (cur.preview) {
      ctx.font = '10px ' + MONO;
      ctx.textAlign = 'right';
      ctx.fillStyle = kindColor(cur.kind, p);
      ctx.fillText(cur.preview, W - padR, curY + 0.5);
      ctx.textAlign = 'left';
    }

    // sibling strip — current level neighbours, ±2
    var stripTop = top + totalRows * rowH + 3;
    ctx.strokeStyle = p.borderSubtle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(4, stripTop + 0.5);
    ctx.lineTo(W - 4, stripTop + 0.5);
    ctx.stroke();

    var sibs = trail.siblings || [];
    if (sibs.length) {
      var innerW = W - padL - padR;
      var cell = innerW / sibs.length;
      var tickY = stripTop + 7;

      for (var j = 0; j < sibs.length; j++) {
        var sb = sibs[j];
        var cx = padL + cell * (j + 0.5);
        var isCur = !!sb.current;

        ctx.strokeStyle = isCur ? p.accent : p.borderStrong;
        ctx.lineWidth = isCur ? 1.5 : 1;
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, tickY);
        ctx.lineTo(cx + 0.5, tickY + (isCur ? 5 : 3));
        ctx.stroke();

        ctx.font = isCur ? '600 8.5px ' + MONO : '8px ' + MONO;
        ctx.fillStyle = isCur ? p.accentText : p.faint;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        var label = ellipsize(ctx, sb.key, cell - 2);
        ctx.fillText(label, cx, tickY + 13);

        if (isCur) {
          var lw = Math.min(ctx.measureText(label).width + 6, cell - 4);
          ctx.strokeStyle = p.accent;
          ctx.globalAlpha = 0.65;
          ctx.beginPath();
          ctx.moveTo(cx - lw / 2, tickY + 20.5);
          ctx.lineTo(cx + lw / 2, tickY + 20.5);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  window.TJVMap = {
    trail: TRAIL,
    draw: draw,
    drawAll: function () {
      var list = document.querySelectorAll('canvas[data-json-map]');
      for (var i = 0; i < list.length; i++) draw(list[i], TRAIL);
    }
  };
})();
