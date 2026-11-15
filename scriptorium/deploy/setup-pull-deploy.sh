#!/bin/bash
# Jednorázové nastavení automatického nasazení na serveru (spustit jako root).
# Použití: bash setup-pull-deploy.sh git@github.com:<organizace>/<repo>.git
set -euo pipefail
REPO=${1:?zadej adresu repa, např. git@github.com:org/educie.git}
BASE=/opt/publisher
install -d -m 700 $BASE/.deploy-key $BASE/bin
[ -f $BASE/.deploy-key/id_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C "deploy@$(hostname)" -f $BASE/.deploy-key/id_ed25519
echo "== Veřejný klíč – vložit do GitHub repa: Settings → Deploy keys (bez Allow write access) =="
cat $BASE/.deploy-key/id_ed25519.pub
HERE=$(cd "$(dirname "$0")" && pwd)
install -m 755 -o root -g root "$HERE/pull-deploy.sh" $BASE/bin/pull-deploy.sh
install -m 644 "$HERE/publisher-deploy.service" /etc/systemd/system/publisher-deploy.service
install -m 644 "$HERE/publisher-deploy.timer" /etc/systemd/system/publisher-deploy.timer
if [ ! -d $BASE/src/.git ]; then
  git init -q $BASE/src
  git -C $BASE/src remote add origin "$REPO"
fi
chmod 700 $BASE/src
systemctl daemon-reload
systemctl enable --now publisher-deploy.timer
echo "Hotovo. Po přidání klíče na GitHub: systemctl start publisher-deploy && journalctl -t publisher-deploy -n 5"
