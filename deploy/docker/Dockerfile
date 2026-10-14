# syntax=docker/dockerfile:1

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    QQNT_BINARY=/opt/QQ/qq \
    QQNT_BRIDGE_ENV_FILE=/var/lib/qqnt-bridge/qqnt-bridge.env

# 默认装上 ffmpeg（语音消息需要）；通话还需要 AVSDK 与 voice-worker。
ARG WITH_FFMPEG=1
ARG WITH_AVSDK=0
ARG QQ_DEB_URL=https://qqdl.gtimg.cn/qqfile/QQNT/9.9.36/beta/9ee04bef/linuxqq_3.2.34-53644_amd64.deb
# release 任务会传入当前 tag 的产物地址：releases/latest 会命中缓存层，可能装进旧注入。
ARG QQNT_BRIDGE_ARCHIVE_URL=https://github.com/xuuuuan/crossgram-qqnt/releases/latest/download/qqnt-bridge-linux-x64-release.tar.gz
ARG QQNT_BRIDGE_VERSION=unknown

# 安装与清理放在同一层，删除才能真正减小镜像；deb 依赖 ffmpeg 带入 ALSA，这里显式安装。
RUN set -eux; \
    apt-get update; \
    packages="ca-certificates curl dbus-x11 desktop-file-utils qrencode util-linux xvfb"; \
    if apt-cache show libasound2t64 >/dev/null 2>&1; then packages="$packages libasound2t64"; else packages="$packages libasound2"; fi; \
    if [ "$WITH_FFMPEG" = 1 ]; then packages="$packages ffmpeg"; fi; \
    apt-get install -y --no-install-recommends $packages; \
    curl -fL --retry 3 -o /tmp/qq.deb "$QQ_DEB_URL"; \
    apt-get install -y --no-install-recommends /tmp/qq.deb; \
    rm -f /tmp/qq.deb; \
    rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/* /usr/share/locale/* /usr/share/icons/*; \
    rm -f /opt/QQ/LICENSES.chromium.html; \
    if [ "$WITH_AVSDK" != 1 ]; then rm -rf /opt/QQ/resources/app/avsdk; fi; \
    rm -f /usr/lib/x86_64-linux-gnu/libLLVM.so.* /usr/lib/x86_64-linux-gnu/libgallium-*.so; \
    rm -rf /usr/lib/x86_64-linux-gnu/dri; \
    test -x /opt/QQ/qq

RUN set -eux; \
    curl -fL --retry 3 -o /tmp/qqnt-bridge.tar.gz "$QQNT_BRIDGE_ARCHIVE_URL"; \
    mkdir -p /opt/qqnt-bridge; \
    tar -xzf /tmp/qqnt-bridge.tar.gz -C /opt/qqnt-bridge; \
    test -f /opt/qqnt-bridge/resources/app.asar; \
    test -f /opt/qqnt-bridge/bin/run-headless.sh; \
    install -m 0644 /opt/qqnt-bridge/resources/app.asar /opt/QQ/resources/app.asar; \
    if [ -d /opt/qqnt-bridge/resources/app.asar.unpacked ]; then \
      cp -a /opt/qqnt-bridge/resources/app.asar.unpacked /opt/QQ/resources/; \
    fi; \
    install -d -m 0755 /usr/local/libexec/qqnt-bridge; \
    install -m 0755 /opt/qqnt-bridge/bin/qqntctl /usr/local/bin/qqntctl; \
    for helper in /opt/qqnt-bridge/bin/*; do \
      case "${helper##*/}" in qqntctl) continue ;; esac; \
      install -m 0755 "$helper" "/usr/local/libexec/qqnt-bridge/${helper##*/}"; \
    done; \
    printf '%s\n' "$QQNT_BRIDGE_VERSION" > /opt/qqnt-bridge/VERSION; \
    printf '%s\n' "$QQNT_BRIDGE_ARCHIVE_URL" > /opt/qqnt-bridge/SOURCE_URL; \
    rm -f /tmp/qqnt-bridge.tar.gz

COPY entrypoint.sh /opt/qqnt-bridge/entrypoint.sh
COPY qq-wrapper.sh /usr/local/libexec/qqnt-bridge/qq-wrapper.sh

RUN set -eux; \
    useradd --create-home --home-dir /var/lib/qqnt-bridge --shell /usr/sbin/nologin qqnt; \
    install -d -m 0700 -o qqnt -g qqnt /var/lib/qqnt-bridge \
      /var/lib/qqnt-bridge/log /var/lib/qqnt-bridge/backups; \
    chmod 0755 /opt/qqnt-bridge/entrypoint.sh /usr/local/libexec/qqnt-bridge/qq-wrapper.sh

USER qqnt
ENV HOME=/var/lib/qqnt-bridge
EXPOSE 18767
# 用桥接端自己的客户端探测自己的 API，token 与状态文件只有一处；QQ 启动需要时间，故设 start-period。
HEALTHCHECK --interval=15s --timeout=10s --retries=20 --start-period=180s CMD ["qqntctl", "status"]
ENTRYPOINT ["/opt/qqnt-bridge/entrypoint.sh"]
