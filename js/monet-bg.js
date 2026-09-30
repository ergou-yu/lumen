/* ============================================================
   monet-bg.js —— 莫奈印象派 · 点彩水面背景
   来源：motion-skill-kit / snippets/styles/impressionism.html
   遵循套件规约：参数集中在 CONFIG；保留 prefers-reduced-motion 降级
   （一次性补足 8 秒等效笔触后定格，交付一幅画完的静态作品）；
   只按本项目需要调参数（app UI 叠在画面上，笔数略降），不改实现逻辑。
   印象派的调色宪法：不调色，互补色并置（蓝↔橙、紫↔黄绿），
   眼睛在远处自己混合——所以这里永远没有硬边、永远在缓慢演化。
   ============================================================ */
(function () {
  "use strict";

  // ===== 视觉参数集中区（只改这里，不动下方实现） =====
  var CONFIG = {
    // 睡莲色板：[颜色, 权重]——深蓝占大头、落日橙少量点缀才有「光」
    palette: [
      ["#3d6b8e", 5],  // 深水蓝
      ["#6fa3c2", 6],  // 天光蓝
      ["#9ec9d8", 4],  // 浅反光
      ["#e8b04b", 2],  // 落日橙（蓝的互补：少量点缀才有"光"）
      ["#c98bb9", 2],  // 睡莲粉紫
      ["#7fae7a", 1],  // 反射的绿意
      ["#f2ead8", 1],  // 高光米白（波峰闪光）
    ],
    dotMin: 6, dotMax: 16,     // 色斑尺寸（px）：莫奈的笔触大而松，不是修拉的精密圆点
    layerAlpha: 0.16,          // 每层透明度：叠十几层后色彩自然"混"出光感
    strokesPerFrame: 32,       // 每帧补笔数（原片段 40；Lumen 的 UI 叠在画面上方，略降）
    driftSpeed: 0.00012,       // 色彩场漂移速度：水面微光的"呼吸"
    warpScale: 0.004,          // 噪声尺度：决定色斑聚集的"水团"大小
    isMobile: window.matchMedia("(pointer: coarse)").matches,
  };
  if (CONFIG.isMobile) CONFIG.strokesPerFrame = 20;

  var prefersReducedMotion =
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var canvas = document.getElementById("monet-bg");
  var ctx = canvas.getContext("2d");
  var W, H;

  function resize() {
    var ratio = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    paintBase();
  }

  // 按权重展开色板 → 抽色时直接随机索引，比每次算权重便宜
  var bag = [];
  for (var pi = 0; pi < CONFIG.palette.length; pi++) {
    for (var wi = 0; wi < CONFIG.palette[pi][1]; wi++) bag.push(CONFIG.palette[pi][0]);
  }
  function pick() { return bag[Math.floor(Math.random() * bag.length)]; }

  // ---- 轻量噪声：sin 组合伪噪声足够驱动"水面光斑"的聚散 ----
  function noise(x, y, t) {
    return (
      Math.sin(x * 1.7 + t) * Math.cos(y * 1.3 - t * 0.7) +
      Math.sin((x + y) * 0.9 + t * 0.5) * 0.5
    ) * 0.5 + 0.5; // 归一到 0~1
  }

  function paintBase() {
    // 底色：中灰蓝。印象派的白画布传统——亮底子让多层薄涂透出光
    ctx.fillStyle = "#7fa3bd";
    ctx.fillRect(0, 0, W, H);
  }

  // 画一笔"色斑"：椭圆 + 随机角度 = 笔触方向感（印象派的笔触是有姿态的）
  function strokeAt(t) {
    // 噪声值决定这一笔的位置偏好：高值区域多画 → 色彩成团，像水波聚光
    var nx = Math.random(), ny = Math.random();
    var n = noise(nx * 4, ny * 3, t);
    if (n < 0.35 && Math.random() < 0.6) return; // 低值区域跳过部分笔触 → 留出深色"水隙"

    var x = nx * W + (Math.random() - 0.5) * 40;
    var y = ny * H + (Math.random() - 0.5) * 40;

    ctx.save();
    ctx.translate(x, y);
    // 角度跟随噪声梯度：邻近的笔触方向相近 → 成"水流"肌理
    ctx.rotate(Math.sin(y * CONFIG.warpScale * 8 + t) * 0.9);
    ctx.globalAlpha = CONFIG.layerAlpha;
    ctx.fillStyle = pick();
    var r = CONFIG.dotMin + Math.random() * (CONFIG.dotMax - CONFIG.dotMin);
    ctx.beginPath();
    // 椭圆笔触：长轴 2.2 倍短轴，扁笔刷躺在画布上的形状
    ctx.ellipse(0, 0, r * 2.2, r, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  var t0 = performance.now();

  function paintFor(secondsEquivalent) {
    // 降级与初始化共用：一次性补足 N 层笔触，得到"已画完"的静态成品
    var frames = Math.floor(secondsEquivalent * 60);
    for (var i = 0; i < frames; i++) {
      var t = (i / 60) * 0.2;
      for (var s = 0; s < CONFIG.strokesPerFrame; s++) strokeAt(t);
    }
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () {
    // 防抖：resize 期间连续重铺底色代价高
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resize(); if (prefersReducedMotion) paintFor(8); }, 200);
  });
  resize();

  if (prefersReducedMotion) {
    // 降级：直接呈现画完的作品（约 8 秒等效笔触量），不再有后续演化
    paintFor(8);
  } else {
    // 先铺 5 秒等效笔触再出场，避免用户看到"空画布"
    paintFor(5);
    (function loop(now) {
      requestAnimationFrame(loop);
      var t = (now - t0) * CONFIG.driftSpeed;
      for (var i = 0; i < CONFIG.strokesPerFrame; i++) strokeAt(t);
    })(t0);
  }

  // 暴露给文件 Tab：让 Lumi 用同一支画笔为用户作画（生成艺术文件）
  window.MonetBG = {
    palette: CONFIG.palette,
    // 在离屏 canvas 上画一幅小画（补足笔触后定格），返回 dataURL
    paintPicture: function (width, height, seconds) {
      var off = document.createElement("canvas");
      var ratio = 2;
      off.width = width * ratio;
      off.height = height * ratio;
      var octx = off.getContext("2d");
      octx.setTransform(ratio, 0, 0, ratio, 0, 0);
      // 局部复用同样的技法：换一个闭包内的小实现，避免污染主循环状态
      var savedCtx = ctx, savedW = W, savedH = H;
      ctx = octx; W = width; H = height;
      paintBase();
      paintFor(seconds || 6);
      ctx = savedCtx; W = savedW; H = savedH;
      // JPEG 而非 PNG：高噪声点彩图 PNG 动辄数百 KB～数 MB，几张就会撑爆 localStorage 配额
      return off.toDataURL("image/jpeg", 0.82);
    },
  };
})();
