#!/usr/bin/env bash
# Optional Ubuntu helper. Windows 11 is the supported venue OS.
# This script only prints the files to edit; it does not switch the project to Linux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Supported path is Windows 11. See KIOSK.md."
echo "If you still want Ubuntu, copy:"
echo "  $ROOT/scripts/kiosk.service"
echo "to ~/.config/systemd/user/pinball-land-kiosk.service"
echo "then: systemctl --user daemon-reload && systemctl --user enable --now pinball-land-kiosk.service"
echo "Set GDM autologin, disable suspend, and GRUB timeout=0 yourself."
