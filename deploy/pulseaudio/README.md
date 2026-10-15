# QQ PulseAudio 虚拟音频设备

`qq-virtual-devices.pa` 用于为无头 QQ 专属 PulseAudio 守护进程创建语音通话所需的虚拟设备：
- `qq_sink`：48 kHz 双声道虚拟扬声器（默认输出）
- `qq_mic_sink`：48 kHz 单声道虚拟麦克风输入池
- `qq_source`：从 `qq_mic_sink.monitor` 重映射的单声道虚拟麦克风（默认输入）

> 请仅在专属 PulseAudio 守护进程的启动配置中 `.include` 一次，切勿通过 `pactl` 重复加载或写入桌面用户的 `default.pa`。

## 1. 安装步骤

1. 确认专属守护进程使用的配置文件路径（如 `systemctl cat qq-pulse.service` 中的 `--file`，通常为 `/etc/pulse/qq-headless.pa`）。
2. 备份原配置并准备新配置：
   ```sh
   config=/etc/pulse/qq-headless.pa
   stamp=$(date +%Y%m%d-%H%M%S)
   sudo cp -a "$config" "$config.$stamp"
   sudo cp -a "$config" "$config.next"
   sudoedit "$config.next"
   ```
   移除其中手动加载 `qq_sink`、`qq_mic_sink`、`qq_source` 的旧配置行，改为添加一行：
   ```pa
   .include /etc/pulse/qq-headless.pa.d/qq-virtual-devices.pa
   ```
3. 安装配置片段并原子替换：
   ```sh
   fragment=/etc/pulse/qq-headless.pa.d/qq-virtual-devices.pa
   sudo install -d -m 0755 /etc/pulse/qq-headless.pa.d
   sudo install -m 0644 deploy/pulseaudio/qq-virtual-devices.pa "$fragment.new"
   sudo mv -f "$fragment.new" "$fragment"
   sudo mv -f "$config.next" "$config"
   ```

## 2. 验证与回滚

重启专属 PulseAudio 服务后，执行只读校验脚本：

```sh
PULSE_SERVER=unix:/run/qq-pulse/native deploy/pulseaudio/verify-qq-virtual-devices.sh
```

如需回滚，恢复备份文件并重启专属 PulseAudio 服务：

```sh
sudo mv -f "$config.$stamp" "$config"
```
