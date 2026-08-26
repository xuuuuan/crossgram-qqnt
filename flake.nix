{
  description = "Standalone QQNT bridge launcher";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfree = true;
      };
      lib = pkgs.lib;
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
      src = lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            base = baseNameOf path;
          in
            lib.cleanSourceFilter path type
            && !(builtins.elem base [ "flake.nix" "flake.lock" "yarn.lock" "node_modules" "dist" "data" "backups" "result" "target" "artifacts" ])
            && !(lib.hasPrefix "result-" base);
      };
      nodejs = pkgs.nodejs-slim_24;
      pnpm = pkgs.pnpm_10.override { nodejs-slim = nodejs; };
      cargoVendor = pkgs.rustPlatform.fetchCargoVendor {
        pname = "qqnt-bridge-native-deps";
        inherit version src;
        cargoRoot = "native/packet-addon";
        hash = "sha256-MCvuxnIwJgpynBD1tdElo6kohPsEeg/HhRw2oksFcgM=";
      };
      assets = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "qqnt-bridge-assets";
        inherit version src;

        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          inherit pnpm;
          fetcherVersion = 4;
          hash = "sha256-m9p2QIypAbtoA2HqdWfFS/dc5dMRYF0eUjFcrjbYOK8=";
        };

        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
          pkgs.rustc
          pkgs.cargo
          pkgs.gnumake
          pkgs.pkg-config
          pkgs.gnutar
          pkgs.curl
        ];

        preBuild = ''
          export CARGO_HOME="$TMPDIR/cargo-home"
          mkdir -p "$CARGO_HOME" .cargo
          cat > .cargo/config.toml <<EOF
          [net]
          offline = true

          [source.crates-io]
          replace-with = "vendored-sources"

          [source.vendored-sources]
          directory = "${cargoVendor}/source-registry-0"
          EOF
        '';

        buildPhase = ''
          runHook preBuild
          pnpm package:release
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p "$out"
          tar -xzf dist/packages/qqnt-bridge-linux-x64-release.tar.gz -C "$out"
          test -f "$out/resources/app.asar"
          test -f "$out/resources/app.asar.unpacked/qqnt_packet.linux-x64-gnu.node"
          runHook postInstall
        '';
      });
      qq = pkgs.qq.overrideAttrs (old: {
        postInstall = (old.postInstall or "") + ''
          install -Dm644 ${assets}/resources/app.asar \
            "$out/opt/QQ/resources/app.asar"
          install -Dm755 \
            ${assets}/resources/app.asar.unpacked/qqnt_packet.linux-x64-gnu.node \
            "$out/opt/QQ/resources/app.asar.unpacked/qqnt_packet.linux-x64-gnu.node"
        '';
      });
      fonts = pkgs.makeFontsConf {
        fontDirectories = [ pkgs.source-han-sans ];
      };
      runtime = pkgs.writeShellScriptBin "qqnt-runtime" ''
        display=$1
        vnc_port=$2
        novnc_port=$3
        media_socket=$4
        bridge_env=$5

        create_service() {
          mkdir -p "/services/$1"
          printf '%s\n' "#!${pkgs.runtimeShell}" "$2" > "/services/$1/run"
          chmod +x "/services/$1/run"
        }

        export PATH=${lib.makeBinPath [ pkgs.busybox pkgs.xorg-server pkgs.x11vnc pkgs.dbus pkgs.dunst pkgs.novnc pkgs.pulseaudio ]}
        export HOME=/root
        export XDG_DATA_HOME=/root/.local/share
        export XDG_CONFIG_HOME=/root/.config
        export TERM=xterm
        export QQNT_MEDIA_SOCKET="$media_socket"
        export QQNT_BRIDGE_ENV="$bridge_env"
        mkdir -p /root/.local/share /root/.config /etc/ssl/certs /etc/fonts /etc/dbus /run/dbus /tmp /usr/bin /bin
        printf '%s\n' 'root:x:0:0::/root:${pkgs.runtimeShell}' > /etc/passwd
        printf '%s\n' 'root:x:0:' > /etc/group
        ln -s ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt /etc/ssl/certs/ca-bundle.crt
        ln -s ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt /etc/ssl/certs/ca-certificates.crt
        ln -s ${fonts} /etc/fonts/fonts.conf
        ln -s "$(command -v env)" /usr/bin/env
        ln -s "$(command -v sh)" /bin/sh
        cp ${pkgs.dbus}/share/dbus-1/system.conf /etc/dbus/system.conf
        sed -i '/<user>messagebus<\/user>/d' /etc/dbus/system.conf
        sed -i 's/<deny/<allow/' /etc/dbus/system.conf
        rm -f /run/dbus/pid
        export DBUS_SESSION_BUS_ADDRESS='unix:path=/run/dbus/system_bus_socket'
        export DISPLAY=:$display
        create_service xvfb "Xvfb :$display"
        # LibVNCServer counts free descriptors by walking 0..RLIMIT_NOFILE with
        # fcntl() on every incoming connection, so an inherited "infinity" soft
        # limit (pm2, systemd) wedges the accept path at 100% CPU. Cap it.
        create_service x11vnc "ulimit -Sn 1024; exec x11vnc -forever -display :$display -rfbport $vnc_port"
        create_service novnc "novnc --vnc localhost:$vnc_port --listen $novnc_port --file-only"
        create_service dbus 'dbus-daemon --nofork --config-file=/etc/dbus/system.conf'
        create_service dunst 'dunst'

        if [ -n "$media_socket" ]; then
          mkdir -p /root/.pulse-runtime
          chmod 700 /root/.pulse-runtime
          export XDG_RUNTIME_DIR=/root/.pulse-runtime
          export PULSE_SERVER=unix:/root/.pulse-runtime/native
          export QQNT_BRIDGE_MEDIA_GATEWAY=1
          export QQNT_BRIDGE_MEDIA_PULSE_SERVER="$PULSE_SERVER"
          export QQNT_BRIDGE_MEDIA_SOCKET="$media_socket"
          export QQNT_BRIDGE_MEDIA_SOCKET_MODE=0600
          create_service pulse 'pulseaudio -n --daemonize=no --exit-idle-time=-1 \
            --load="module-native-protocol-unix socket=/root/.pulse-runtime/native auth-anonymous=1" \
            --load="module-null-sink sink_name=qq_sink rate=48000 channels=2" \
            --load="module-null-sink sink_name=qq_mic_sink rate=48000 channels=1 channel_map=mono" \
            --load="module-remap-source source_name=qq_source master=qq_mic_sink.monitor channels=1 master_channel_map=mono channel_map=mono"'
        fi

        mkdir -p /services/program
        cat > /services/program/run <<'EOF'
        #!${pkgs.runtimeShell}
        if [ -n "$QQNT_MEDIA_SOCKET" ]; then
          rm -f -- "$QQNT_MEDIA_SOCKET"
          until pactl info >/dev/null 2>&1; do sleep 0.1; done
          pactl set-default-sink qq_sink
          pactl set-default-source qq_source
        fi
        if [ -f "$QQNT_BRIDGE_ENV" ]; then
          set -a
          . "$QQNT_BRIDGE_ENV"
          set +a
        fi
        export PATH=${pkgs.ffmpeg}/bin:$PATH
        exec ${qq}/bin/qq --no-sandbox --disable-gpu "$@"
        EOF
        chmod +x /services/program/run
        runsvdir /services
      '';
      qqnt = pkgs.writeShellApplication {
        name = "qqnt";
        runtimeInputs = [ pkgs.bubblewrap pkgs.coreutils ];
        text = ''
          data_dir="''${1:-$PWD/data}"
          display="''${2:-99}"
          vnc_port="''${3:-5900}"
          novnc_port="''${4:-6080}"
          media_socket="''${5:-}"
          bridge_env="/root/''${6:-qqnt-bridge.env}"

          mkdir -p -- "$data_dir"
          bwrap_args=(
            --unshare-all
            --share-net
            --as-pid-1
            --uid 0 --gid 0
            --clearenv
            --ro-bind /nix/store /nix/store
            --bind "$data_dir" /root
            --dir /etc
            --ro-bind /etc/resolv.conf /etc/resolv.conf
            --proc /proc
            --dev /dev
            --tmpfs /tmp
          )
          if [ -n "$media_socket" ]; then
            media_dir=$(dirname "$media_socket")
            mkdir -p -- "$media_dir"
            chmod 700 -- "$media_dir"
            bwrap_args+=(
              --dir /root/.pulse-runtime
              --tmpfs /root/.pulse-runtime
              --dir /run
              --bind "$media_dir" "$media_dir"
            )
          fi
          exec ${pkgs.bubblewrap}/bin/bwrap "''${bwrap_args[@]}" \
            ${runtime}/bin/qqnt-runtime \
            "$display" "$vnc_port" "$novnc_port" "$media_socket" "$bridge_env"
        '';
      };
    in {
      packages.${system} = {
        default = qqnt;
        qqnt = qqnt;
        qqnt-bridge-assets = assets;
      };
      apps.${system} = {
        default = {
          type = "app";
          program = "${qqnt}/bin/qqnt";
        };
        qqnt = {
          type = "app";
          program = "${qqnt}/bin/qqnt";
        };
      };
    };
}
