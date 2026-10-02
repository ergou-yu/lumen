"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { PRESETS, DEFAULT, normalize, restoreAppearance, wallpaperSvg, decodeWallpaper, createTheme } = require("../vm-box/desktop-theme");
const svgUpload = svg => ({ mime: "image/svg+xml", data: Buffer.from(svg).toString("base64") });

test("出厂主题包含 Lumi 壁纸和雾粉强调色，另外提供 60 套静态组合", () => {
  assert.equal(new Set(PRESETS.map(p => p.id)).size, 61);
  assert.equal(DEFAULT.preset, "lumi-oat-rose");
  assert.equal(DEFAULT.accent, "#d5a4b2");
  const file = path.join(__dirname, "../vm-box/assets", PRESETS[0].wallpaper);
  assert.equal(decodeWallpaper({mime:"image/png",data:fs.readFileSync(file).toString("base64")}).ext,"png");
  assert.deepEqual(createTheme(path.join(__dirname, "missing-home")).read(), DEFAULT);
  for (const preset of PRESETS.filter(p => !p.wallpaper)) {
    const svg = wallpaperSvg(preset.id);
    assert.equal(decodeWallpaper(svgUpload(svg)).ext, "svg");
    assert.ok(svg.includes(preset.colors[0]));
  }
});
test("旧出厂主题迁移到 Lumi，用户偏好与自定义壁纸不会被升级覆盖", () => {
  const old = { preset:"oat-0", accent:"#c2ad78", custom:false };
  assert.deepEqual(restoreAppearance(old, false), DEFAULT);
  assert.deepEqual(restoreAppearance({ ...old, version:3 }, false), { ...old, version:3 });
  const own = { ...old, accent:"#112233" };
  assert.deepEqual(restoreAppearance(own, false), { ...own, version:3 });
  const custom = { ...old, custom:true };
  assert.deepEqual(restoreAppearance(custom, true), { ...custom, version:3 });
  assert.equal(restoreAppearance(custom, false).custom, false);
  assert.deepEqual(restoreAppearance({preset:"missing"},false), DEFAULT);
});
test("强调色更新保留自定义壁纸；组合与重置会恢复内置壁纸", () => {
  const custom = { ...DEFAULT, custom: true };
  assert.deepEqual(normalize({ accent: "#ABCDEF" }, custom), { ...custom, accent: "#abcdef" });
  assert.equal(normalize({ preset: "blue-2" }, custom).custom, false);
  assert.deepEqual(normalize({ reset: true }, custom), DEFAULT);
  for (const input of [{accent:"#fff\nExec=sh"}, {preset:"../../private"}, null, []]) assert.throws(() => normalize(input));
});
test("壁纸拒绝可执行 SVG、外部文件引用、伪造格式和超限输入", () => {
  const bad = [
    '<svg><script>alert(1)</script></svg>',
    '<svg><foreignObject>html</foreignObject></svg>',
    '<svg><image href="file:///etc/passwd"/></svg>',
    '<svg><style>rect{fill:url(https://example.com/a)}</style></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><style>@import "x"</style></svg>',
  ];
  bad.forEach(svg => assert.throws(() => decodeWallpaper(svgUpload(svg))));
  assert.throws(() => decodeWallpaper({ mime:"image/png", data: Buffer.from("pretend png").toString("base64") }));
  assert.throws(() => decodeWallpaper({ mime:"image/png", data:"A".repeat(8 * 1024 * 1024 + 4) }));
});
