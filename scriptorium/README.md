<img src="logo.svg" alt="Educie.Scriptorium" height="48">

Webový editor pro práci se starými tisky. Sken stránky je vlevo, přepsaný text vpravo, vedle něj vlastní rukopis. Obrázky se dají vyříznout a narovnat, odstavce i citace přenést do rukopisu jedním kliknutím a nad všemi texty se lze ptát jazykového modelu, který odpovídá s odkazy na zdroje.

Co umí:

- **přidání zdrojové knihy** – fotografie stran nebo PDF (vykresluje se v prohlížeči), řazení tažením, otočení, mazání; text se čte v pozadí jazykovým modelem s viděním (rozpozná nadpisy, poznámky a polohu obrázků, které se samy vyříznou), záložně Tesseractem; znovu přečtení strany nebo stran bez textu,
- **MCP server** pro Claude (claude.ai i aplikace na počítači) a jiné MCP klienty – tajná adresa z Nastavení AI; nástroje list_books, list_pages, get_page (obrázek strany a text), set_page_text, update_block, search_text,
- rozcestník **Moje knihy** – více rozepsaných knih, každá s vlastním textem, historií verzí a nastavením (titulní strana, tiráž, záhlaví a zápatí, obálka),
- **originál a transkripce** vedle sebe, výřezy a narovnání obrázků, nový ořez z původní strany skenu, srovnání perspektivy za čtyři rohy, úpravy jasu, kontrastu a sytosti, vrácení původního textu odstavce a historie transkripce,
- **editor obálky** – rozvržení, fotografie posouvaná a zvětšovaná přímo na obálce, posun a velikost textu, barvy, přechod, logo Educie Press bílé nebo černé podle pozadí; obálka zvlášť pro e-knihu a pro tisk A4 a zůstává upravitelná,
- **záznam přístupů a změn** – přihlášení, IP adresa a otisk zařízení; u každé verze rukopisu i transkripce je vidět, kdo ji vytvořil,
- **korektura** v transkripci i v rukopisu (český a německý slovník, typické chyby OCR, slovník knihy a centrální slovník),
- **rukopis** s automatickým obsahem, novou stránkou, vkládáním citací, celých transkripcí a obrázků (z aplikace, z počítače, z kamery),
- **Dotaz** – odpovědi jazykového modelu jen z textů knih s čísly zdrojů; model na serveru, vlastní klíč OpenAI / Anthropic nebo LM Studio / Ollama,
- **export** do PDF (stránkování, obálka, titulní strana, tiráž, obsah s čísly stran) a do e-knihy EPUB,
- rozhraní v češtině, angličtině a němčině, světlý a tmavý režim, průvodce aplikací a formulář podpory.

Aplikace je jeden Python proces bez databáze a bez závislostí mimo standardní knihovnu (kontrolu pravopisu zajišťuje přibalená knihovna spylls a slovníky LibreOffice ve složce `app/dict/`). OCR nástroje ve `app/tools/` potřebují Tesseract, OpenCV a Pillow.

## Spuštění na počítači

    PUBLISHER_DATA=~/Knihy python3 app/server.py

Pak otevřít http://localhost:2209. `PUBLISHER_DATA` je složka s knihami (každá kniha je podsložka se souborem `project.json`). Bez přihlašovacích proměnných běží aplikace v lokálním režimu bez hesla.

## Server

Viz [`deploy/INSTALL.md`](deploy/INSTALL.md): systemd služba, nginx a automatické nasazení z GitHubu.

## Proměnné prostředí

Viz [`deploy/env.example`](deploy/env.example). Přihlašovací PIN se ukládá jen jako hash (`python3 app/auth.py <PIN>`).
