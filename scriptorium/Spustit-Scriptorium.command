#!/bin/bash
# Spustí Scriptorium na Macu a otevře ho v prohlížeči.
# Data (knihy) jsou ve složce PUBLISHER_DATA, výchozí ~/Knihy.
cd "$(dirname "$0")/app" || exit 1
export PUBLISHER_DATA="${PUBLISHER_DATA:-$HOME/Knihy}"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Chybí python3. Nainstaluj ho příkazem: xcode-select --install"
  read -r -p "Enter = zavřít"; exit 1
fi
OLD=$(lsof -ti tcp:2209 -sTCP:LISTEN 2>/dev/null)
[ -n "$OLD" ] && { echo "Ukončuji starší běžící Scriptorium…"; kill $OLD 2>/dev/null; sleep 1; }
(sleep 1.5; open "http://localhost:2209") &
python3 server.py
