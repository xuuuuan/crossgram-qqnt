#!/usr/bin/env bash
# Read-only PulseAudio metadata validation. It never loads modules or records audio.
set -u

pactl_bin=${PACTL_BIN:-pactl}

pactl_read() {
  command "$pactl_bin" "$@" 2>/dev/null
}

contains_field() {
  local value=$1
  local field=$2
  local token
  local -a tokens

  read -r -a tokens <<< "$value"
  for token in "${tokens[@]}"; do
    [[ $token == "$field" ]] && return 0
  done

  return 1
}

module_count() {
  local modules=$1
  local wanted_type=$2
  local wanted_field=$3
  local index module args
  local count=0

  while IFS=$'\t' read -r index module args; do
    if [[ $module == "$wanted_type" ]] && contains_field "$args" "$wanted_field"; then
      count=$((count + 1))
    fi
  done <<< "$modules"

  printf '%s\n' "$count"
}

has_module_fields() {
  local modules=$1
  local wanted_type=$2
  shift 2
  local index module args field

  while IFS=$'\t' read -r index module args; do
    [[ $module == "$wanted_type" ]] || continue
    for field in "$@"; do
      contains_field "$args" "$field" || continue 2
    done
    return 0
  done <<< "$modules"

  return 1
}

has_device() {
  local devices=$1
  local wanted_name=$2
  local index name driver spec state

  while IFS=$'\t' read -r index name driver spec state; do
    [[ $name == "$wanted_name" ]] && return 0
  done <<< "$devices"

  return 1
}

has_device_spec() {
  local devices=$1
  local wanted_name=$2
  local wanted_channels=$3
  local index name driver spec state format channels rate extra

  while IFS=$'\t' read -r index name driver spec state; do
    [[ $name == "$wanted_name" ]] || continue
    read -r format channels rate extra <<< "$spec"
    if [[ -n $format && $channels == "${wanted_channels}ch" && $rate == 48000Hz && -z $extra ]]; then
      return 0
    fi
  done <<< "$devices"

  return 1
}

has_exact_line() {
  local text=$1
  local wanted_line=$2
  [[ $'\n'$text$'\n' == *$'\n'$wanted_line$'\n'* ]]
}

has_exact_count() {
  [[ $1 == "$2" ]]
}

all_valid=true
check() {
  local label=$1
  shift

  if "$@"; then
    printf '%s=true\n' "$label"
  else
    printf '%s=false\n' "$label"
    all_valid=false
  fi
}

info=$(pactl_read info || true)
modules=$(pactl_read list short modules || true)
sinks=$(pactl_read list short sinks || true)
sources=$(pactl_read list short sources || true)

qq_sink_module_count=$(module_count "$modules" module-null-sink sink_name=qq_sink)
printf 'qq_sink.module_count=%s\n' "$qq_sink_module_count"
check qq_sink.module_count_is_one has_exact_count "$qq_sink_module_count" 1
check qq_sink.present has_device "$sinks" qq_sink
check qq_sink.sample_spec_48k_stereo has_device_spec "$sinks" qq_sink 2
check qq_sink.module_is_48k_stereo has_module_fields "$modules" module-null-sink sink_name=qq_sink rate=48000 channels=2

qq_mic_sink_module_count=$(module_count "$modules" module-null-sink sink_name=qq_mic_sink)
printf 'qq_mic_sink.module_count=%s\n' "$qq_mic_sink_module_count"
check qq_mic_sink.module_count_is_one has_exact_count "$qq_mic_sink_module_count" 1
check qq_mic_sink.present has_device "$sinks" qq_mic_sink
check qq_mic_sink.sample_spec_48k_mono has_device_spec "$sinks" qq_mic_sink 1
check qq_mic_sink.module_is_48k_mono has_module_fields "$modules" module-null-sink sink_name=qq_mic_sink rate=48000 channels=1 channel_map=mono

check qq_mic_sink.monitor.present has_device "$sources" qq_mic_sink.monitor
check qq_mic_sink.monitor.sample_spec_48k_mono has_device_spec "$sources" qq_mic_sink.monitor 1

qq_source_module_count=$(module_count "$modules" module-remap-source source_name=qq_source)
printf 'qq_source.module_count=%s\n' "$qq_source_module_count"
check qq_source.module_count_is_one has_exact_count "$qq_source_module_count" 1
check qq_source.present has_device "$sources" qq_source
check qq_source.sample_spec_48k_mono has_device_spec "$sources" qq_source 1
check qq_source.master_is_qq_mic_sink_monitor has_module_fields "$modules" module-remap-source source_name=qq_source master=qq_mic_sink.monitor channels=1 master_channel_map=mono channel_map=mono

check default.sink_is_qq_sink has_exact_line "$info" 'Default Sink: qq_sink'
check default.source_is_qq_source has_exact_line "$info" 'Default Source: qq_source'

printf 'valid=%s\n' "$all_valid"
[[ $all_valid == true ]]
