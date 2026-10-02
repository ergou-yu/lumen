#!/usr/bin/env python3
"""原生外观面板：设置保存在容器的私有 home 卷，通过控制服务即时应用。"""
import base64
import json
import mimetypes
import tkinter as tk
from tkinter import ttk, colorchooser, filedialog, messagebox
from urllib.request import Request, urlopen

URL = "http://127.0.0.1:3900/appearance"

def api(data=None):
    req = Request(URL, data=json.dumps(data).encode() if data is not None else None,
                  headers={"Content-Type": "application/json"})
    with urlopen(req, timeout=35) as res:
        value = json.load(res)
    if not value.get("ok"):
        raise RuntimeError(value.get("error", "设置失败"))
    return value

root = tk.Tk()
root.title("Lumi · 桌面外观")
root.geometry("560x340")
root.configure(background="#f4edde")
root.resizable(False, False)
state = api()
presets = state["presets"]
accent = tk.StringVar(value=state["accent"])
frame = ttk.Frame(root, padding=24)
frame.pack(fill="both", expand=True)
ttk.Label(frame, text="让这台电脑有你的颜色", font=("Noto Sans", 17)).pack(anchor="w", pady=(0, 12))
ttk.Label(frame, text="Lumi 专属主题 + 60 套组合 · 重启后保留").pack(anchor="w", pady=(0, 20))
choice = ttk.Combobox(frame, values=[p["name"] for p in presets], state="readonly", width=40)
choice.current(next((i for i, p in enumerate(presets) if p["id"] == state["preset"]), 0))
choice.pack(anchor="w", pady=5)
choice.bind("<<ComboboxSelected>>", lambda _: accent.set(presets[choice.current()]["accent"]))
row = ttk.Frame(frame)
row.pack(anchor="w", pady=10)
ttk.Label(row, text="标题栏与 Dock 强调色：").pack(side="left")
ttk.Entry(row, textvariable=accent, width=10).pack(side="left", padx=8)
def pick():
    value = colorchooser.askcolor(accent.get(), parent=root)[1]
    if value:
        accent.set(value)
ttk.Button(row, text="选颜色", command=pick).pack(side="left")
info = tk.StringVar(value="当前：自定义壁纸" if state["custom"] else "当前：" + presets[choice.current()]["name"])
ttk.Label(frame, textvariable=info).pack(anchor="w", pady=10)
buttons = ttk.Frame(frame)
buttons.pack(anchor="w", pady=8)
def apply(data):
    try:
        result = api(data)
        accent.set(result["accent"])
        choice.current(next((i for i, p in enumerate(presets) if p["id"] == result["preset"]), 0))
        info.set("已保存，桌面外观已更新")
    except Exception as exc:
        messagebox.showerror("无法更新", str(exc), parent=root)
def upload():
    file = filedialog.askopenfilename(parent=root, filetypes=[("壁纸", "*.png *.jpg *.jpeg *.svg")])
    if file:
        with open(file, "rb") as stream:
            data = stream.read(6 * 1024 * 1024 + 1)
        if len(data) > 6 * 1024 * 1024:
            messagebox.showerror("图片过大", "最大 6 MB", parent=root)
            return
        apply({"accent": accent.get(), "wallpaper": {"mime": mimetypes.guess_type(file)[0], "data": base64.b64encode(data).decode()}})
ttk.Button(buttons, text="应用组合", command=lambda: apply({"preset": presets[choice.current()]["id"], "accent": accent.get()})).pack(side="left", padx=(0, 8))
ttk.Button(buttons, text="仅改强调色", command=lambda: apply({"accent": accent.get()})).pack(side="left", padx=8)
ttk.Button(buttons, text="上传壁纸", command=upload).pack(side="left", padx=8)
ttk.Button(buttons, text="恢复默认", command=lambda: apply({"reset": True})).pack(side="left", padx=8)
root.mainloop()
