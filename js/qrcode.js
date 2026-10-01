/* ============================================================
   qrcode.js —— 零依赖二维码编码器（仅二维码模式 1-3 · ECC M · 单块）
   用途：设置页「手机访问」渲染扫码直达地址。
   输入限制：纯字节内容 ≤ 42 字符（覆盖局域网地址场景）；
   超限返回 null，调用方降级为文字地址。
   导出：window.LumenQR.encode(text) → 二维矩阵（0/1 数组的数组）或 null
   ============================================================ */
(function (global) {
  "use strict";

  // —— GF(256)，本原多项式 0x11D ——
  var EXP = new Array(512), LOG = new Array(256);
  (function initGF() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();
  function gmul(a, b) { return (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]]; }

  // RS 生成多项式（n 个校验符号）
  function rsGenPoly(n) {
    var poly = [1];
    for (var i = 0; i < n; i++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var k = 0; k < poly.length; k++) {
        next[k] ^= poly[k];                        // ×x：高位保持
        next[k + 1] ^= gmul(poly[k], EXP[i]);      // ×αⁱ：低一位
      }
      poly = next;
    }
    return poly; // 高次在前
  }
  function rsEncode(data, n) {
    var gen = rsGenPoly(n);
    var rem = data.concat(new Array(n).fill(0));
    for (var i = 0; i < data.length; i++) {
      var factor = rem[i];
      if (factor === 0) continue;
      for (var j = 0; j < gen.length; j++) {
        rem[i + j] ^= gmul(gen[j], factor);
      }
    }
    return rem.slice(data.length);
  }

  // 版本表（ECC M · 单块）：[版本] = { dataCodewords, eccCodewords, align }
  var VERSIONS = {
    1: { data: 16, ecc: 10, align: [] },
    2: { data: 28, ecc: 16, align: [18] },
    3: { data: 44, ecc: 26, align: [22] },
  };

  function pickVersion(len) {
    // 字节模式容量（ECC M）：v1=14, v2=26, v3=42
    if (len <= 14) return 1;
    if (len <= 26) return 2;
    if (len <= 42) return 3;
    return 0;
  }

  function buildCodewords(bytes, ver) {
    var spec = VERSIONS[ver];
    var bits = [];
    function push(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); }
    push(4, 4);                       // 模式：字节
    push(bytes.length, 8);            // 字符数（v1-9）
    bytes.forEach(function (b) { push(b, 8); });
    var cap = spec.data * 8;
    push(0, Math.min(4, cap - bits.length));       // 终止符
    while (bits.length % 8 !== 0) bits.push(0);
    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0; for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    var pads = [0xec, 0x11], p = 0;
    while (codewords.length < spec.data) codewords.push(pads[p++ % 2]);
    return codewords.concat(rsEncode(codewords, spec.ecc));
  }

  function makeMatrix(ver) {
    var size = 17 + 4 * ver;
    var m = [];
    for (var r = 0; r < size; r++) m.push(new Array(size).fill(null)); // null=未定
    function set(r, c, v) { if (r >= 0 && r < size && c >= 0 && c < size) m[r][c] = v; }

    // 三个定位图案 + 分隔带
    function finder(r0, c0) {
      for (var dr = -1; dr <= 7; dr++) {
        for (var dc = -1; dc <= 7; dc++) {
          var r = r0 + dr, c = c0 + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          var dark = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) &&
            (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
             (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
          set(r, c, dark ? 1 : 0);
        }
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // 校正图案
    VERSIONS[ver].align.forEach(function (center) {
      for (var dr = -2; dr <= 2; dr++) {
        for (var dc = -2; dc <= 2; dc++) {
          var d = Math.max(Math.abs(dr), Math.abs(dc));
          set(center + dr, center + dc, (d === 1 || d === 3) ? 0 : 1);
        }
      }
    });

    // 时序图案
    for (var i = 8; i < size - 8; i++) {
      if (m[6][i] === null) m[6][i] = (i % 2 === 0) ? 1 : 0;
      if (m[i][6] === null) m[i][6] = (i % 2 === 0) ? 1 : 0;
    }

    // 格式信息占位（两个副本的位域稍后统一回填）
    for (var k = 0; k < 9; k++) {
      if (m[8][k] === null) m[8][k] = 0;
      if (m[k][8] === null) m[k][8] = 0;
    }
    for (var k2 = 1; k2 < 9; k2++) {
      if (m[8][size - k2] === null) m[8][size - k2] = 0;
      if (m[size - k2][8] === null) m[size - k2][8] = 0;
    }
    m[size - 8][8] = 1; // 固定暗模块
    return m;
  }

  function reserveFormat(m) {
    // 标准位序 bit14..bit0，双副本（左上一份 + 右下延伸一份）
    var size = m.length;
    var coords = [
      [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
      [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
    ];
    for (var i = 0; i <= 6; i++) coords.push([size - 1 - i, 8]); // 副本二：bit14..8
    for (var j = 0; j <= 7; j++) coords.push([8, size - 8 + j]); // 副本二：bit7..0
    return coords;
  }

  function placeData(m, codewords) {
    var size = m.length;
    var bitIdx = 0, totalBits = codewords.length * 8;
    function bitAt(i) {
      if (i >= totalBits) return 0;
      return (codewords[i >> 3] >> (7 - (i & 7))) & 1;
    }
    var col = size - 1, upward = true;
    while (col > 0) {
      if (col === 6) col--; // 跳过时序列
      for (var step = 0; step < size; step++) {
        var r = upward ? size - 1 - step : step;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (m[r][c] === null) m[r][c] = bitAt(bitIdx++);
        }
      }
      upward = !upward;
      col -= 2;
    }
  }

  // 掩码函数
  var MASKS = [
    function (r, c) { return ((r + c) & 1) === 0; },
    function (r, c) { return (r & 1) === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (((r >> 1) + Math.floor(c / 3)) & 1) === 0; },
    function (r, c) { return (((r * c) & 1) + ((r * c) % 3)) === 0; },
    function (r, c) { return ((((r * c) & 1) + ((r * c) % 3)) & 1) === 0; },
    function (r, c) { return ((((r + c) & 1) + ((r * c) % 3)) & 1) === 0; },
  ];

  function formatBits(maskId) {
    // ECC=M(00) + maskId 的 BCH(15,5)，再异或 0x5412
    var data = (0 << 3) | maskId; // M 的级别位是 00
    var rem = data << 10;
    for (var i = 14; i >= 10; i--) {
      if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    }
    return ((data << 10) | rem) ^ 0x5412;
  }

  function applyMaskAndFormat(m, maskId) {
    var size = m.length;
    var fmt = formatBits(maskId);
    // 先掩码数据模块（仅原数据位：非函数图案）。为区分，重建函数图标记：
    // 简化做法：掩码仅作用于 placeData 写入的位置——用占位快照判断。
    // 这里在调用方先做快照，见 encode。
    var fmtCoords = reserveFormat(m);
    // 回填格式信息：副本一（coords[0..14]）与副本二（coords[15..29]）同序承载 bit14..bit0
    for (var k = 0; k < fmtCoords.length && k < 30; k++) {
      var bit = (fmt >> (14 - (k % 15))) & 1;
      m[fmtCoords[k][0]][fmtCoords[k][1]] = bit;
    }
    return m;
  }

  function penalty(m) {
    var size = m.length, score = 0, r, c;
    // 规则1：行/列连续同色 ≥5
    for (r = 0; r < size; r++) {
      var run = 1;
      for (c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (c = 0; c < size; c++) {
      var run2 = 1;
      for (r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run2++; if (run2 === 5) score += 3; else if (run2 > 5) score++; }
        else run2 = 1;
      }
    }
    // 规则2：2×2 同色块
    for (r = 0; r < size - 1; r++) for (c = 0; c < size - 1; c++) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
    // 规则4：明暗比例
    var dark = 0;
    for (r = 0; r < size; r++) for (c = 0; c < size; c++) dark += m[r][c];
    var ratio = Math.abs(dark * 100 / (size * size) - 50) / 5;
    score += Math.floor(ratio) * 10;
    return score;
  }

  function encode(text) {
    var bytes = [];
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      if (code > 0xff) return null; // 简化：仅支持单字节内容（URL 场景足够）
      bytes.push(code);
    }
    var ver = pickVersion(bytes.length);
    if (!ver) return null;
    var codewords = buildCodewords(bytes, ver);
    var size = 17 + 4 * ver;

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      // 重建底板 → 放数据 → 记录数据位 → 掩码 → 格式位 → 评分
      var m = makeMatrix(ver);
      placeData(m, codewords);
      var dataCells = [];
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
        // 数据位即“非函数图案”位：底板为 null 且被 placeData 填充——用重建法判断太重，
        // 简化：placeData 后再对照一块“无数据底板”即可。
        dataCells.push(0);
      }
      // 无数据底板对照
      var bare = makeMatrix(ver);
      for (var rr = 0; rr < size; rr++) for (var cc = 0; cc < size; cc++) {
        if (bare[rr][cc] === null && m[rr][cc] !== null) {
          // 数据位：施加掩码
          if (MASKS[mask](rr, cc)) m[rr][cc] ^= 1;
        }
      }
      // 格式位（回填前占位归零，避免被当数据）
      applyMaskAndFormat(m, mask);
      var sc = penalty(m);
      if (sc < bestScore) { bestScore = sc; best = m; }
    }
    return best;
  }

  global.LumenQR = { encode: encode };
})(typeof window !== "undefined" ? window : globalThis);
