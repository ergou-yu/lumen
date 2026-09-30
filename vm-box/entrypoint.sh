#!/bin/sh
# LumenBox Desktop 启动序列：X → 窗口管理器 → VNC → noVNC → Chromium(CDP) → 控制服务
set -e
export DISPLAY=:0

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp &
until xdpyinfo >/dev/null 2>&1; do sleep 0.2; done

openbox &
x11vnc -display :0 -forever -shared -nopw -quiet -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6901 localhost:5900 >/tmp/websockify.log 2>&1 &

# Chromium：真实 GUI 浏览器，开 CDP 供观察（只在本机回环内）
# 私有卷跨容器复用，先清掉上个容器实例留下的 profile 锁（容器主机名每次都变）
rm -f "$HOME/.config/chromium/Singleton"* 2>/dev/null || true
chromium \
  --no-sandbox --disable-dev-shm-usage --disable-gpu --disable-software-rasterizer \
  --test-type --hide-crash-restore-bubble \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --window-size=1280,780 --window-position=0,0 \
  --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter \
  --lang=zh-CN "about:blank" >/tmp/chromium.log 2>&1 &

exec node /opt/box/box-server.js
