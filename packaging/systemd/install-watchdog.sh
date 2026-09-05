#!/usr/bin/env bash
# Install the health watchdog as a user timer. No root required.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNITS"

sed "s#^ExecStart=.*#ExecStart=$REPO/tools/loop-watchdog.sh#" \
  "$HERE/dshrc-watchdog.service" > "$UNITS/dshrc-watchdog.service"
cp "$HERE/dshrc-watchdog.timer" "$UNITS/dshrc-watchdog.timer"

systemctl --user daemon-reload
systemctl --user enable --now dshrc-watchdog.timer
echo "  installed. next run:"
systemctl --user list-timers dshrc-watchdog.timer --no-pager | sed -n '2p'
echo "  logs:  journalctl --user -t dshrc-watchdog -f"
