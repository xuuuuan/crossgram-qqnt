{
  description = "Reproducible QQNT bridge assets and headless QQ launchers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs {
        inherit system;
        config.allowUnfreePredicate = package: pkgs.lib.getName package == "qq";
      };
      lib = pkgs.lib;
      src = lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let
            base = baseNameOf path;
          in
            lib.cleanSourceFilter path type
            && !(builtins.elem base [ "yarn.lock" "node_modules" "dist" "data" "backups" "result" "target" "artifacts" ])
            && !(lib.hasPrefix "result-" base);
      };
      nodejs = pkgs.nodejs-slim_24;
      pnpm = pkgs.pnpm_10.override { inherit nodejs; };
      cargoVendor = pkgs.rustPlatform.fetchCargoVendor {
        pname = "qqnt-bridge-native-deps";
        version = "1.0.17";
        inherit src;
        cargoRoot = "native/packet-addon";
        hash = "sha256-MCvuxnIwJgpynBD1tdElo6kohPsEeg/HhRw2oksFcgM=";
      };
      assets = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "qqnt-bridge-assets";
        version = "1.0.17";
        inherit src;

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

        doCheck = true;
        checkPhase = ''
          pnpm exec vitest run deploy/deploy-files.test.ts
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
      makeLauncher = name: defaultDataDir:
        pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [
            pkgs.bubblewrap
            pkgs.runit
            pkgs.xorg-server
            pkgs.x11vnc
            pkgs.novnc
            pkgs.dbus
            pkgs.noto-fonts-cjk-sans
            pkgs.wqy_zenhei
            pkgs.coreutils
          ];
          text = ''
            set -eu

            data_dir=${lib.escapeShellArg defaultDataDir}
            display=:99
            vnc_port=5900
            novnc_port=6080

            usage() {
              cat <<'EOF'
            Usage: ${name} [--data-dir PATH] [--display DISPLAY] [--vnc-port PORT] [--novnc-port PORT]

            Launch QQ with the qqnt-bridge injection in an isolated Xvfb session.
            EOF
            }

            require_port() {
              case "$1" in
                ""|*[!0-9]*|0|[1-9][0-9][0-9][0-9][0-9]*)
                  printf '%s\n' "invalid port: $1" >&2
                  exit 2
                  ;;
              esac
            }

            while [ "$#" -gt 0 ]; do
              case "$1" in
                --data-dir)
                  [ "$#" -ge 2 ] || { printf '%s\n' '--data-dir requires a path' >&2; exit 2; }
                  data_dir=$2
                  shift 2
                  ;;
                --display)
                  [ "$#" -ge 2 ] || { printf '%s\n' '--display requires a value' >&2; exit 2; }
                  display=$2
                  shift 2
                  ;;
                --vnc-port)
                  [ "$#" -ge 2 ] || { printf '%s\n' '--vnc-port requires a port' >&2; exit 2; }
                  vnc_port=$2
                  shift 2
                  ;;
                --novnc-port)
                  [ "$#" -ge 2 ] || { printf '%s\n' '--novnc-port requires a port' >&2; exit 2; }
                  novnc_port=$2
                  shift 2
                  ;;
                --help|-h)
                  usage
                  exit 0
                  ;;
                *)
                  printf '%s\n' "unknown option: $1" >&2
                  usage >&2
                  exit 2
                  ;;
              esac
            done

            require_port "$vnc_port"
            require_port "$novnc_port"
            case "$data_dir" in
              /*) ;;
              *) printf '%s\n' '--data-dir must be an absolute path' >&2; exit 2 ;;
            esac

            mkdir -p "$data_dir/home" "$data_dir/config" "$data_dir/data" "$data_dir/cache" "$data_dir/state" /tmp/.X11-unix
            runtime_dir=$(mktemp -d "/tmp/qqnt.XXXXXX")
            trap 'rm -rf "$runtime_dir"' EXIT INT TERM
            mkdir -p "$runtime_dir/service/xvfb" "$runtime_dir/service/vnc" "$runtime_dir/service/novnc" "$runtime_dir/service/qq" "$runtime_dir/resources" "$runtime_dir/dbus"
            cat > "$runtime_dir/dbus/session.conf" <<'EOF'
            <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
             "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
            <busconfig>
              <type>session</type>
              <listen>unix:tmpdir=/tmp</listen>
              <auth>EXTERNAL</auth>
              <policy context="default">
                <allow send_destination="*"/>
                <allow receive_sender="*"/>
                <allow own="*"/>
              </policy>
            </busconfig>
            EOF
            for resource in ${pkgs.qq}/opt/QQ/resources/*; do
              case "$(basename "$resource")" in
                app.asar|app.asar.unpacked) ;;
                *) ln -s "$resource" "$runtime_dir/resources/$(basename "$resource")" ;;
              esac
            done
            ln -s ${assets}/resources/app.asar "$runtime_dir/resources/app.asar"
            ln -s ${assets}/resources/app.asar.unpacked "$runtime_dir/resources/app.asar.unpacked"

            cat > "$runtime_dir/service/xvfb/run" <<EOF
            #!${pkgs.runtimeShell}
            exec ${pkgs.xorg-server}/bin/Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp
            EOF
            cat > "$runtime_dir/service/vnc/run" <<EOF
            #!${pkgs.runtimeShell}
            exec ${pkgs.x11vnc}/bin/x11vnc -display "$display" -localhost -forever -shared -rfbport "$vnc_port"
            EOF
            cat > "$runtime_dir/service/novnc/run" <<EOF
            #!${pkgs.runtimeShell}
            exec ${pkgs.novnc}/bin/novnc_proxy --listen "$novnc_port" --vnc "localhost:$vnc_port"
            EOF
            cat > "$runtime_dir/service/qq/run" <<EOF
            #!${pkgs.runtimeShell}
            export DISPLAY="$display"
            export FONTCONFIG_FILE=${pkgs.fontconfig.out}/etc/fonts/fonts.conf
            exec ${pkgs.bubblewrap}/bin/bwrap --die-with-parent --new-session --share-net --tmpfs / --dir /nix --dir /tmp --dir /tmp/.X11-unix --dir /etc --dir /etc/dbus-1 --proc /proc --dev /dev --ro-bind /nix /nix --ro-bind /tmp/.X11-unix /tmp/.X11-unix --ro-bind "$runtime_dir/dbus/session.conf" /etc/dbus-1/session.conf --dir /data --bind "$data_dir" /data --ro-bind "$runtime_dir/resources" ${pkgs.qq}/opt/QQ/resources --setenv HOME /data/home --setenv XDG_CONFIG_HOME /data/config --setenv XDG_DATA_HOME /data/data --setenv XDG_CACHE_HOME /data/cache --setenv XDG_STATE_HOME /data/state --chdir /data ${pkgs.dbus}/bin/dbus-run-session --config-file=/etc/dbus-1/session.conf -- ${pkgs.qq}/bin/qq
            EOF
            chmod 700 "$runtime_dir"/service/*/run

            exec ${pkgs.runit}/bin/runsvdir -P "$runtime_dir/service"
          '';
        };
      qqnt = makeLauncher "qqnt" "/root/qqnt-bridge/data/default";
    in {
      packages.${system} = {
        default = qqnt;
        qqnt = qqnt;
        qqnt-bridge-assets = assets;
      };
      apps.${system} = {
        default = { type = "app"; program = "${qqnt}/bin/qqnt"; };
        qqnt = { type = "app"; program = "${qqnt}/bin/qqnt"; };
      };
    };
}
