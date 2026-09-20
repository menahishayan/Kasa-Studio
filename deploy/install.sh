#!/usr/bin/bash
# One-time setup for running Kasa Studio as a standalone appliance on a
# Raspberry Pi: installs dependencies, registers the systemd service, and
# starts it. Networking (the self-hosted AP + hostname) is then managed by
# the app itself at runtime via the Network settings panel.
#
# Run from the repo root: sudo bash deploy/install.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash deploy/install.sh" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-pi}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

# node/npm are commonly installed via nvm, which only wires itself onto PATH
# in *interactive* bash shells (guarded at the top of ~/.bashrc). Neither
# `sudo -u`, `bash -lc`, nor systemd trigger that, so PATH lookups for
# node/npm silently fail outside an interactive terminal. Source nvm.sh
# directly (it has no such guard) to resolve the real absolute paths instead.
resolve_node_bin() {
  sudo -u "$RUN_USER" bash -c '
    if command -v node >/dev/null 2>&1; then command -v node; exit; fi
    export NVM_DIR="'"$RUN_HOME"'/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
    command -v node
  '
}

NODE_BIN="$(resolve_node_bin)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Could not find a node binary for user '$RUN_USER' (checked PATH and nvm). Install Node.js first." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
NPM_BIN="$NODE_DIR/npm"
echo "==> Using node at $NODE_BIN"

echo "==> Installing npm dependencies"
# npm's shebang is `#!/usr/bin/env node`, so `node` still needs to be on PATH
# even when invoking npm by absolute path.
sudo -u "$RUN_USER" env "PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$NPM_BIN" --prefix "$REPO_DIR" ci --omit=dev

echo "==> Checking for NetworkManager and avahi-daemon"
for bin in nmcli avahi-daemon; do
  if ! command -v "$bin" >/dev/null; then
    echo "Missing $bin — install network-manager and avahi-daemon first." >&2
    exit 1
  fi
done
systemctl enable --now avahi-daemon

echo "==> Installing systemd service"
sed \
  -e "s#/home/pi/Kasa-Studio#${REPO_DIR}#" \
  -e "s/^User=pi/User=${RUN_USER}/" \
  -e "s#/usr/bin/node#${NODE_BIN}#" \
  -e "/^\[Service\]/a Environment=PATH=${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "$REPO_DIR/deploy/kasa-studio.service" > /etc/systemd/system/kasa-studio.service
systemctl daemon-reload
systemctl enable --now kasa-studio

echo
echo "Installed. The service is running as user '$RUN_USER' and needs passwordless"
echo "sudo access to nmcli/hostnamectl to manage the access point and hostname —"
echo "verify with: sudo -l -U $RUN_USER"
echo
echo "IMPORTANT: enabling the self-hosted access point switches this Pi's Wi-Fi"
echo "radio away from any network it's currently joined to. If you're connected"
echo "to this Pi over that same Wi-Fi network right now, that connection will"
echo "drop. Plug in Ethernet first if you want to keep remote access, or be"
echo "ready to join the new access point's network from the settings panel."
