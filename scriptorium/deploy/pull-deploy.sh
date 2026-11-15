#!/bin/bash
# Automatické nasazení: stáhne větev main z GitHubu a nasadí jen složku scriptorium/app.
# Běží jako root ze systemd timeru. Soubor patří rootovi a nikdo jiný ho nemůže měnit.
set -euo pipefail
BASE=/opt/publisher
SRC=$BASE/src                # klon repa (jen pro čtení přes deploy key)
APP=$BASE/app                # běžící kód
STATE=$BASE/.deployed        # naposledy nasazený commit
BRANCH=main
export GIT_SSH_COMMAND="ssh -i $BASE/.deploy-key/id_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$BASE/.deploy-key/known_hosts"

cd "$SRC"
git fetch -q origin "$BRANCH"
NEW=$(git rev-parse "origin/$BRANCH")
OLD=$(cat "$STATE" 2>/dev/null || echo none)
[ "$NEW" = "$OLD" ] && exit 0

git -c advice.detachedHead=false checkout -q --force "$NEW"
# kontrola, že se Python dá přeložit, než se cokoli přepíše
python3 -m py_compile scriptorium/app/*.py scriptorium/app/tools/*.py

rm -rf "$APP.prev"; cp -a "$APP" "$APP.prev"
rsync -a --delete --exclude '__pycache__' scriptorium/app/ "$APP/"
echo "$NEW" > "$APP/VERSION"
chown -R root:publisher "$APP"; chmod -R u=rwX,g=rX,o= "$APP"
systemctl restart publisher
sleep 3
PORT=$(grep -oP '^PUBLISHER_PORT=\K\d+' $BASE/deploy/.env || echo 2209)
if curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null; then
  echo "$NEW" > "$STATE"
  logger -t publisher-deploy "nasazen $NEW"
else
  logger -t publisher-deploy "CHYBA: $NEW neodpovídá, vracím předchozí verzi"
  rsync -a --delete "$APP.prev/" "$APP/"
  systemctl restart publisher
  echo "$NEW" > "$STATE"   # vadný commit znovu nezkoušet, čeká se na další push
  exit 1
fi
