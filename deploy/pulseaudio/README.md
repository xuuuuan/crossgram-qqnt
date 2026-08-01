# QQ PulseAudio virtual devices

`qq-virtual-devices.pa` is a startup-only PulseAudio fragment for the dedicated
QQ daemon. It creates a 48 kHz stereo `qq_sink`, a 48 kHz mono
`qq_mic_sink`, and a mono `qq_source` remapped from `qq_mic_sink.monitor`.
It also makes `qq_sink` and `qq_source` the daemon defaults.

Do not run the fragment through `pactl` and do not include it more than once.
Those operations load a second set of modules. Its idempotent deployment model
is one include in one daemon startup file; replacing the installed fragment
changes nothing in a running daemon until the operator deliberately restarts
that daemon.

## Install

These are operator instructions only; this repository does not install files,
reload systemd, or restart PulseAudio.

1. Inspect the dedicated daemon command first. For the existing QQ service,
   `systemctl cat qq-pulse.service` identifies the `--file` startup
   configuration. Do not change a desktop user's `default.pa`.
2. Create a timestamped backup of that startup configuration, then prepare a
   complete sibling candidate with `sudoedit` (substitute the actual `--file`
   path if it differs):

   ```sh
   config=/etc/pulse/qq-headless.pa
   stamp=$(date +%Y%m%d-%H%M%S)
   sudo cp -a "$config" "$config.$stamp"
   sudo cp -a "$config" "$config.next"
   sudoedit "$config.next"
   ```

   In the candidate, remove any old lines that load modules named `qq_sink`,
   `qq_mic_sink`, or `qq_source`, and add exactly one line:

   ```pa
   .include /etc/pulse/qq-headless.pa.d/qq-virtual-devices.pa
   ```

3. Stage the fragment and replace it atomically on the same filesystem. Keep a
   timestamped copy too when a fragment already exists:

   ```sh
   fragment=/etc/pulse/qq-headless.pa.d/qq-virtual-devices.pa
   sudo install -d -m 0755 /etc/pulse/qq-headless.pa.d
   if sudo test -e "$fragment"; then
     sudo cp -a "$fragment" "$fragment.$stamp"
   fi
   sudo install -m 0644 deploy/pulseaudio/qq-virtual-devices.pa "$fragment.new"
   sudo mv -f "$fragment.new" "$fragment"
   ```

4. Atomically rename the reviewed startup-config candidate over the configured
   `--file` path:

   ```sh
   sudo mv -f "$config.next" "$config"
   ```

   A daemon restart is an explicit operator action, not part of this asset.

## Verify

After an operator has restarted only the dedicated daemon, run the read-only
validator against its socket:

```sh
PULSE_SERVER=unix:/run/qq-pulse/native \
  deploy/pulseaudio/verify-qq-virtual-devices.sh
```

The output contains only fixed check names, boolean values, and module counts.
It does not print PulseAudio metadata, audio, or credentials. Exit status zero
means every check passed.

## Atomic rollback

Keep the timestamped startup-config backup and, if one was present, the
fragment backup until verification succeeds. To roll back, restore the startup
config first. Then restore the previous fragment when one existed; otherwise,
rename the new fragment aside. Each replacement is an atomic rename within its
directory:

```sh
sudo mv -f "$config.$stamp" "$config"
if sudo test -e "$fragment.$stamp"; then
  sudo mv -f "$fragment.$stamp" "$fragment"
else
  sudo mv -f "$fragment" "$fragment.disabled"
fi
```

Then have the operator restart only the dedicated PulseAudio daemon. Do not use
`pactl unload-module` for rollback: module indexes are runtime-specific and
unloading live modules can disrupt audio.
