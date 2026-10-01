# ============================================================
# LumenBox Desktop —— Lumi 的「Muse Secure VM」本地等价物
# 一个完整的 Linux 桌面容器：Xvfb + openbox + Chromium + VNC/noVNC
# + 零依赖 Node 控制服务（观察/输入注入/截图，供宿主 Sentinel 调用）。
# 安全模型对标 Muse：容器内只有执行器；审批（Sentinel）、凭证安全区、
# 任务状态全部在宿主服务桥里，容器碰不到、关不掉。
# 构建：docker build -t lumen-box vm-box/
# 注：默认换 USTC 镜像源并分层安装——慢网络下大包可断点续建。
# ============================================================
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0

# 国内网络优化：deb.debian.org → USTC 镜像（海外网络可删掉这一段）
RUN sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g; s|security.debian.org|mirrors.ustc.edu.cn|g' \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get update -o Acquire::Retries=8

# 大包单独一层（chromium ~120MB / 中文字体 ~60MB）：失败重试时命中缓存，不再重复下载
RUN apt-get install -y --no-install-recommends -o Acquire::Retries=10 \
      chromium fonts-noto-cjk

# 其余依赖一层（含中文 locale：否则浏览器下载的中文文件名会退化为 "download"）
RUN apt-get install -y --no-install-recommends -o Acquire::Retries=10 \
      xvfb xauth x11-utils xdotool imagemagick \
      x11vnc novnc websockify openbox \
      fonts-noto-color-emoji ca-certificates locales \
    && sed -i 's/^# \(zh_CN.UTF-8 UTF-8\)/\1/; s/^# \(en_US.UTF-8 UTF-8\)/\1/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=zh_CN.UTF-8 LC_ALL=zh_CN.UTF-8

COPY box-server.js /opt/box/box-server.js
COPY entrypoint.sh /opt/box/entrypoint.sh
RUN chmod +x /opt/box/entrypoint.sh /opt/box/box-server.js

# node 基础镜像自带 UID 1000 的 node 用户，直接用它（非 root）
USER node
WORKDIR /home/node
VOLUME /home/node
EXPOSE 3900 6901

ENTRYPOINT ["/opt/box/entrypoint.sh"]
