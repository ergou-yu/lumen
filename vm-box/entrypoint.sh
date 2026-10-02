#!/bin/sh
# LumenBox Desktop 启动序列：X → 窗口管理器 → VNC → noVNC → Chromium(CDP) → 控制服务
set -e
export DISPLAY=:0
export TZ="${TZ:-Asia/Shanghai}"
export XDG_RUNTIME_DIR="/tmp/lumen-runtime-$(id -u)"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
# GTK / Qt 创作应用需要会话总线，避免首次打开时出现连接失败。
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  exec dbus-run-session -- "$0"
fi

Xvfb :0 -screen 0 1280x800x24 -nolisten tcp &
until xdpyinfo >/dev/null 2>&1; do sleep 0.2; done

node /opt/box/desktop-theme.js
openbox >/tmp/openbox.log 2>&1 &
until xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id #'; do sleep 0.1; done
feh --no-fehbg --bg-fill "$HOME/.config/lumen-desktop/wallpaper.png"
tint2 >/tmp/tint2.log 2>&1 &
x11vnc -display :0 -forever -shared -nopw -quiet -noxdamage >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc 6901 localhost:5900 >/tmp/websockify.log 2>&1 &

# Chromium：真实 GUI 浏览器，开 CDP 供观察（只在本机回环内）
# 私有卷跨容器复用，先清掉上个容器实例留下的 profile 锁（容器主机名每次都变）
rm -f "$HOME/.config/chromium/Singleton"* 2>/dev/null || true
chromium \
  --no-sandbox --disable-dev-shm-usage \
  --enable-unsafe-swiftshader \
  --test-type --hide-crash-restore-bubble \
  --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --window-size=1160,640 --window-position=60,38 \
  --no-first-run --no-default-browser-check --disable-features=Translate,MediaRouter \
  --lang=zh-CN "about:blank" >/tmp/chromium.log 2>&1 &

exec node /opt/box/box-server.js
