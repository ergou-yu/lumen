"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { execFile } = require("node:child_process");

// 莫兰迪色板集中在这里：暖灰压低饱和度，窗口文字另用深灰保证对比。
const PALETTES = [
  ["oat", "莫兰迪燕麦黄", "#eee5cc", "#d8c89c", "#b4a171", "#c2ad78"],
  ["sand", "沙丘米黄", "#eee7d8", "#d6c9b1", "#b3a084", "#bea47f"],
  ["rose", "雾粉", "#eee0de", "#d6bcbc", "#ad9394", "#c1979a"],
  ["sage", "鼠尾草绿", "#e3e7da", "#bcc8b0", "#929f89", "#a1b38f"],
  ["blue", "灰蓝", "#dfe6e9", "#b4c6cf", "#8da4b0", "#96b0bf"],
  ["navy", "深海蓝", "#929faa", "#566d80", "#354d60", "#698aa3"],
  ["lavender", "灰紫", "#e8e2eb", "#c8bed1", "#a598b1", "#b5a2c5"],
  ["clay", "陶土", "#eee0d4", "#d0b49f", "#ae8e79", "#bd9980"],
  ["olive", "橄榄灰", "#e6e4d5", "#c6c3a4", "#a09d7d", "#afac86"],
  ["peach", "杏色", "#f0e4d5", "#d9c0a5", "#b49b85", "#c4a47e"],
  ["stone", "暖石灰", "#e9e5df", "#cbc4b9", "#a69d90", "#b1a592"],
  ["mist", "青雾", "#e0e9e5", "#b9ceca", "#92aaa6", "#9bbcb4"],
];
const STYLES = ["柔光", "层叠", "远山", "圆弧", "流沙"];
const LUMI_PRESET = { id: "lumi-oat-rose", name: "Lumi · 燕麦黄与雾粉", colors: ["#eee5cc", "#e8c3ca", "#bab2d1"], accent: "#d5a4b2", wallpaper: "lumi-oat-rose-wallpaper.png" };
const PRESETS = [LUMI_PRESET, ...PALETTES.flatMap(p => STYLES.map((s, i) => ({
  id: p[0] + "-" + i, name: p[1] + " · " + s, colors: p.slice(2, 5), accent: p[5], style: i,
})))];
const DEFAULT = { preset: LUMI_PRESET.id, accent: LUMI_PRESET.accent, custom: false, version: 3 };
const LUMI_ICON = path.join(__dirname, "assets", "lumi-avatar.png");
const APPLICATIONS = [
  ["browser", "浏览器", "chromium", "chromium --no-sandbox --disable-dev-shm-usage --lang=zh-CN", "chromium"],
  ["terminal", "终端", "lxterminal", "lxterminal --working-directory=/home/node/Downloads", "utilities-terminal"],
  ["files", "文件管理器", "pcmanfm", "pcmanfm /home/node/Downloads", "system-file-manager"],
  ["gimp", "GIMP 修图", "gimp", "gimp", "gimp"],
  ["inkscape", "Inkscape 矢量绘图", "inkscape", "inkscape", "org.inkscape.Inkscape"],
  ["blender", "Blender 3D", "blender", "blender", "blender"],
  ["kdenlive", "Kdenlive 视频剪辑", "kdenlive", "kdenlive", "kdenlive"],
  ["appearance", "Lumi · 桌面外观", "python3", "python3 /opt/box/appearance.py", fs.existsSync(LUMI_ICON) ? LUMI_ICON : "preferences-desktop-theme"],
];

function normalize(input, current = DEFAULT) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("外观设置格式错误");
  const next = { ...current };
  if (input.reset === true) return { ...DEFAULT };
  if (input.preset !== undefined) {
    const p = PRESETS.find(p => p.id === input.preset);
    if (!p) throw new Error("未知壁纸组合");
    next.preset = p.id; next.accent = p.accent; next.custom = false;
  }
  if (input.accent !== undefined) {
    if (typeof input.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(input.accent)) throw new Error("强调色必须是 #RRGGBB");
    next.accent = input.accent.toLowerCase();
  }
  return next;
}

function restoreAppearance(saved, customExists) {
  try {
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return { ...DEFAULT };
    // 升级旧的出厂主题；用户选择的其他组合、强调色和上传图片继续保留。
    if (!saved.version && saved.preset === "oat-0" && saved.accent === "#c2ad78" && !saved.custom) return { ...DEFAULT };
    const value = normalize({ preset: saved.preset, accent: saved.accent });
    value.custom = saved.custom === true && customExists;
    return value;
  } catch (_) { return { ...DEFAULT }; }
}

function wallpaperSvg(id) {
  const p = PRESETS.find(p => p.id === id);
  if (!p) throw new Error("未知壁纸组合");
  if (p.wallpaper) throw new Error("该主题使用内置 PNG 壁纸");
  const [a, b, c] = p.colors;
  const shapes = [
    '<ellipse cx="970" cy="135" rx="620" ry="460" fill="url(#glow)"/><path d="M-120 680 Q340 210 750 580 T1450 430 V900 H-120Z" fill="' + c + '" opacity=".14"/>',
    '<path d="M-40 440 Q360 160 830 440 T1350 350 V840 H-40Z" fill="' + b + '" opacity=".55"/><path d="M-40 620 Q360 330 830 590 T1350 580 V840 H-40Z" fill="' + c + '" opacity=".24"/>',
    '<path d="M-40 650 L230 380 480 620 820 330 1320 660 V840 H-40Z" fill="' + b + '" opacity=".55"/><path d="M-40 760 L360 500 690 730 1100 460 1320 620 V840 H-40Z" fill="' + c + '" opacity=".25"/>',
    '<circle cx="1080" cy="250" r="420" fill="' + b + '" opacity=".5"/><circle cx="1080" cy="250" r="310" fill="' + a + '" opacity=".6"/><circle cx="150" cy="850" r="470" fill="' + c + '" opacity=".2"/>',
    '<path d="M-40 660 Q270 340 640 490 T1320 270 V840 H-40Z" fill="' + b + '" opacity=".6"/><path d="M-40 740 Q550 410 900 650 T1320 530 V840 H-40Z" fill="' + c + '" opacity=".28"/>',
  ];
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800"><defs><linearGradient id="base" x2="1" y2="1"><stop stop-color="' + a + '"/><stop offset="1" stop-color="' + b + '"/></linearGradient><radialGradient id="glow"><stop stop-color="' + a + '"/><stop offset="1" stop-color="' + a + '" stop-opacity="0"/></radialGradient></defs><rect width="1280" height="800" fill="url(#base)"/>' + shapes[p.style] + '</svg>';
}

function decodeWallpaper(upload) {
  if (!upload || typeof upload.data !== "string" || upload.data.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.data)) throw new Error("壁纸最大 6 MB，请使用 PNG、JPEG 或 SVG");
  const data = Buffer.from(upload.data, "base64");
  if (!data.length || data.length > 6 * 1024 * 1024) throw new Error("壁纸最大 6 MB");
  const mime = upload.mime;
  if (mime === "image/png" && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { data, ext: "png" };
  if (mime === "image/jpeg" && data[0] === 255 && data[1] === 216 && data[2] === 255) return { data, ext: "jpg" };
  if (mime === "image/svg+xml") {
    const svg = data.toString("utf8").replace(/^\s*<\?xml[^?]*\?>/i, "");
    const content = svg.replace(/\sxmlns=(["'])http:\/\/www\.w3\.org\/2000\/svg\1/g, "");
    const unsafeUrl = (content.match(/url\s*\([^)]*\)/gi) || []).some(value => !/^url\s*\(\s*#[\w-]+\s*\)$/i.test(value));
    // SVG 只作为静态本地画作；禁止加载网络/文件资源与可执行内容。
    if (!/^\s*<svg\b/i.test(svg) || !/<\/svg>\s*$/i.test(svg) || unsafeUrl || /<!|<\?|\\|<\s*(script|foreignObject|iframe|object|embed|image|use|animate\w*|set)\b|\bon\w+\s*=|\b(?:href|src)\s*=|@import|@font-face|(?:https?|file|data|javascript):|&(?!(?:amp|lt|gt|quot|apos);)/i.test(content)) throw new Error("SVG 必须是静态图片，不得包含脚本或外部资源");
    return { data: Buffer.from(svg), ext: "svg" };
  }
  throw new Error("文件内容与 PNG、JPEG 或 SVG 类型不符");
}

function command(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, out, stderr) => {
    if (err) reject(new Error(cmd + "：" + String(stderr || err.message).slice(0, 250))); else resolve(String(out));
  }));
}

function createTheme(home = os.homedir()) {
  const dir = path.join(home, ".config", "lumen-desktop");
  const stateFile = path.join(dir, "appearance.json");
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return restoreAppearance(saved, fs.existsSync(path.join(dir, "custom.png")));
    } catch (_) { return { ...DEFAULT }; }
  }
  function status() { return { ...read(), presets: PRESETS, applications: APPLICATIONS.map(([id, name]) => ({ id, name })) }; }
  async function apply(input = {}, live = true) {
    fs.mkdirSync(dir, { recursive: true });
    const next = normalize(input, read());
    const preset = PRESETS.find(p => p.id === next.preset);
    const source = path.join(dir, "source.svg"), output = path.join(dir, "next.png");
    if (input.wallpaper !== undefined) {
      const upload = decodeWallpaper(input.wallpaper);
      const file = path.join(dir, "upload." + upload.ext);
      fs.writeFileSync(file, upload.data, { mode: 0o600 });
      try {
        if (upload.ext === "svg") await command("rsvg-convert", ["--width", "1280", "--height", "800", "--output", output, file]);
        else {
          const size = await command("identify", ["-ping", "-format", "%w %h", file + "[0]"]);
          const [w, h] = size.split(" ").map(Number);
          if (!(w > 0 && h > 0 && w * h <= 40000000 && w <= 12000 && h <= 12000)) throw new Error("图片尺寸过大（最多 4000 万像素）");
          await command("convert", ["-limit", "memory", "128MiB", "-limit", "map", "128MiB", file + "[0]", "-auto-orient", "-resize", "1280x800^", "-gravity", "center", "-extent", "1280x800", output]);
        }
        fs.copyFileSync(output, path.join(dir, "custom.png")); next.custom = true;
      } finally { fs.rmSync(file, { force: true }); }
    } else if (next.custom) fs.copyFileSync(path.join(dir, "custom.png"), output);
    else if (preset.wallpaper) {
      fs.copyFileSync(path.join(__dirname, "assets", preset.wallpaper), output);
    } else {
      fs.writeFileSync(source, wallpaperSvg(next.preset));
      await command("rsvg-convert", ["--output", output, source]);
    }
    fs.renameSync(output, path.join(dir, "wallpaper.png"));
    const themeDir = path.join(home, ".themes", "Lumen", "openbox-3");
    fs.mkdirSync(themeDir, { recursive: true });
    fs.writeFileSync(path.join(themeDir, "themerc"), `border.width: 1\npadding.width: 10\npadding.height: 7\nwindow.active.title.bg: flat solid\nwindow.active.title.bg.color: ${next.accent}\nwindow.active.label.bg: parentrelative\nwindow.active.label.text.color: #292720\nwindow.active.button.*.bg: parentrelative\nwindow.active.button.*.image.color: #292720\nwindow.active.button.hover.bg: flat solid\nwindow.active.button.hover.bg.color: #eee5cc\nwindow.inactive.title.bg: flat solid\nwindow.inactive.title.bg.color: #e9e5db\nwindow.inactive.label.bg: parentrelative\nwindow.inactive.label.text.color: #57534a\nwindow.inactive.button.*.bg: parentrelative\nwindow.inactive.button.*.image.color: #6e685b\nwindow.*.border.color: #b4a171\nwindow.*.client.color: #eee5cc\nwindow.label.text.justify: center\n`);
    const openDir = path.join(home, ".config", "openbox");
    fs.mkdirSync(openDir, { recursive: true });
    let rc = fs.readFileSync("/etc/xdg/openbox/rc.xml", "utf8").replace(/(<theme>\s*<name>)[^<]*/, "$1Lumen");
    rc = rc.replace("</keyboard>", '<keybind key="W-Return"><action name="Execute"><command>lxterminal --working-directory=/home/node/Downloads</command></action></keybind><keybind key="W-e"><action name="Execute"><command>pcmanfm /home/node/Downloads</command></action></keybind><keybind key="W-d"><action name="ToggleShowDesktop"/></keybind></keyboard>');
    fs.writeFileSync(path.join(openDir, "rc.xml"), rc);
    fs.writeFileSync(path.join(openDir, "menu.xml"), '<?xml version="1.0"?><openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Lumi 的电脑">' + APPLICATIONS.map(([, name,, exec]) => '<item label="' + name + '"><action name="Execute"><command>' + exec + '</command></action></item>').join("") + '<separator/><item label="显示桌面"><action name="ToggleShowDesktop"/></item></menu></openbox_menu>');
    const launchDir = path.join(home, ".local", "share", "applications");
    fs.mkdirSync(launchDir, { recursive: true });
    APPLICATIONS.forEach(([id, name,, exec, icon]) => fs.writeFileSync(path.join(launchDir, "lumen-" + id + ".desktop"), '[Desktop Entry]\nType=Application\nName=' + name + '\nExec=' + exec + '\nIcon=' + icon + '\nTerminal=false\n'));
    const dockDir = path.join(home, ".config", "tint2");
    fs.mkdirSync(dockDir, { recursive: true });
    fs.writeFileSync(path.join(dockDir, "tint2rc"), `rounded = 22\nborder_width = 1\nbackground_color = #fff8ef 100\nborder_color = ${next.accent} 100\nrounded = 10\nborder_width = 0\nbackground_color = ${next.accent} 65\npanel_items = LTC\npanel_size = 760 66\npanel_margin = 0 14\npanel_padding = 14 8 10\npanel_background_id = 1\npanel_position = bottom center horizontal\npanel_layer = top\npanel_dock = 0\nstrut_policy = follow_size\nwm_menu = 1\nautohide = 0\nlauncher_padding = 4 3 8\nlauncher_background_id = 0\nlauncher_icon_background_id = 0\nlauncher_icon_size = 36\nlauncher_icon_theme = Adwaita\n${APPLICATIONS.map(([id]) => "launcher_item_app = " + path.join(launchDir, "lumen-" + id + ".desktop")).join("\n")}\ntaskbar_mode = single_desktop\ntaskbar_padding = 2 0 3\ntaskbar_background_id = 0\ntask_maximum_size = 140 42\ntask_padding = 5 3 5\ntask_icon = 1\ntask_text = 0\ntask_background_id = 0\ntask_active_background_id = 2\ntask_tooltip = 1\nmouse_left = toggle_iconify\nmouse_middle = close\nmouse_right = toggle\ntime1_format = %H:%M\ntime1_font = Noto Sans 11\nclock_font_color = #575044 100\nclock_padding = 8 2\nclock_background_id = 0\n`);
    const gtkDir = path.join(home, ".config", "gtk-3.0");
    fs.mkdirSync(gtkDir, { recursive: true });
    fs.writeFileSync(path.join(gtkDir, "settings.ini"), '[Settings]\ngtk-theme-name=Adwaita\ngtk-icon-theme-name=Adwaita\ngtk-font-name=Noto Sans 10\n');
    fs.writeFileSync(path.join(gtkDir, "gtk.css"), '@define-color theme_selected_bg_color ' + next.accent + ';\n@define-color theme_selected_fg_color #292720;\nheaderbar { background-image: none; background-color: ' + next.accent + '; color: #292720; }\n');
    if (live) {
      await command("feh", ["--no-fehbg", "--bg-fill", path.join(dir, "wallpaper.png")]);
      await command("openbox", ["--reconfigure"]);
      await command("pkill", ["-USR1", "-x", "tint2"]).catch(() => {});
    }
    fs.writeFileSync(stateFile + ".tmp", JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(stateFile + ".tmp", stateFile);
    return status();
  }
  return { read, status, apply };
}

module.exports = { PRESETS, DEFAULT, APPLICATIONS, normalize, restoreAppearance, wallpaperSvg, decodeWallpaper, createTheme };
if (require.main === module) createTheme().apply({}, false).catch(e => { console.error(e.message); process.exitCode = 1; });
