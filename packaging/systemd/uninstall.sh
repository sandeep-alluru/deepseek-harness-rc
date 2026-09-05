#!/usr/bin/env bash
#
# Remove the dshrc user service. Leaves ~/.dshrc (device pairings, VAPID keys)
# alone — uninstalling a service should not silently unpair your phone.
#
#   packaging/systemd/uninstall.sh
#
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/dshrc/dshrc.env"

systemctl --user disable --now dshrc.service 2>/dev/null || true
rm -f "$UNIT_DIR/dshrc.service" "$ENV_FILE"
systemctl --user daemon-reload

echo "dshrc service removed."
echo "  device pairings and push keys kept in ~/.dshrc"
echo "  to drop those too:  rm -rf ~/.dshrc"
echo "  linger left enabled; disable with: loginctl disable-linger $USER"
