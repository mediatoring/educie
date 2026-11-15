# Educie Scriptorium

Webový editor pro práci se starými tisky. Sken stránky je vlevo, přepsaný text vpravo, vedle něj vlastní rukopis. Obrázky se dají vyříznout a narovnat, odstavce i citace přenést do rukopisu jedním kliknutím a nad všemi texty se lze ptát jazykového modelu, který odpovídá s odkazy na zdroje.

Aplikace je jeden Python proces bez databáze a bez závislostí mimo standardní knihovnu. OCR nástroje ve `app/tools/` potřebují Tesseract, OpenCV a Pillow.

## Spuštění na počítači

    PUBLISHER_DATA=~/Knihy python3 app/server.py

Pak otevřít http://localhost:2209. `PUBLISHER_DATA` je složka s knihami (každá kniha je podsložka se souborem `project.json`). Bez přihlašovacích proměnných běží aplikace v lokálním režimu bez hesla.

## Server

Viz [`deploy/INSTALL.md`](deploy/INSTALL.md): systemd služba, nginx a automatické nasazení z GitHubu.

## Proměnné prostředí

Viz [`deploy/env.example`](deploy/env.example). Přihlašovací PIN se ukládá jen jako hash (`python3 app/auth.py <PIN>`).
