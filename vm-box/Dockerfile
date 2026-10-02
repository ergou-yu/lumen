# ============================================================
# LumenBox Desktop —— Lumi 的「Muse Secure VM」本地等价物
# 一个完整的 Linux 桌面容器：Xvfb + openbox + Chromium + VNC/noVNC
# + 零依赖 Node 控制服务（观察/输入注入/截图，供宿主 Sentinel 调用）。
# 安全模型对标 Muse：容器内只有执行器；审批（Sentinel）、凭证安全区、
# 任务状态全部在宿主服务桥里，容器碰不到、关不掉。
# 构建：docker build -t lumen-box vm-box/
# 注：默认换 USTC 镜像源并分层安装——慢网络下大包可断点续建。
# ============================================================
FROM node:22-trixie-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0

# 国内网络优化：deb.debian.org → USTC 镜像（海外网络可删掉这一段）
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
    && sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g; s|http://mirrors.ustc.edu.cn|https://mirrors.ustc.edu.cn|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::Retries=8

# 大包单独一层（chromium ~120MB / 中文字体 ~60MB）：失败重试时命中缓存，不再重复下载
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      chromium fonts-noto-cjk

# 其余依赖一层（含中文 locale：否则浏览器下载的中文文件名会退化为 "download"）
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      xvfb xauth x11-utils xdotool imagemagick \
      x11vnc novnc websockify openbox tint2 feh lxterminal pcmanfm dbus-x11 \
      librsvg2-bin adwaita-icon-theme python3 python3-venv python3-pip python3-tk \
      fonts-noto-color-emoji ca-certificates locales \
    && sed -i 's/^# \(zh_CN.UTF-8 UTF-8\)/\1/; s/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# 创作工具使用 Debian 原生软件包；分层保留大包下载缓存。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      gimp inkscape blender kdenlive ffmpeg python3-pil python3-reportlab \
      poppler-utils git curl zip unzip \
    && rm -rf /var/lib/apt/lists/*

# Kdenlive 的转场/滤镜与 Qt 主题、桌面无障碍总线。
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked apt-get update -o Acquire::Retries=3 \
    && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      frei0r-plugins at-spi2-core mesa-utils qt6-gtk-platformtheme \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8

COPY box-server.js /opt/box/box-server.js
COPY desktop-theme.js appearance.py /opt/box/
COPY assets/ /opt/box/assets/
COPY entrypoint.sh /opt/box/entrypoint.sh
RUN chmod +x /opt/box/entrypoint.sh /opt/box/box-server.js \
    && ln -sfn . /usr/share/novnc/lumen-v2

# node 基础镜像自带 UID 1000 的 node 用户，直接用它（非 root）
USER node
WORKDIR /home/node
VOLUME /home/node
EXPOSE 3900 6901

ENTRYPOINT ["/opt/box/entrypoint.sh"]
