# Instalace na server

Předpoklad: Linux se systemd, Python 3.9+, nginx s HTTPS, git a rsync.

## 1. Uživatel, složky, konfigurace

    useradd --system --home /opt/publisher --shell /usr/sbin/nologin publisher
    install -d -o root -g publisher -m 750 /opt/publisher /opt/publisher/app /opt/publisher/deploy
    install -d -o publisher -g publisher -m 750 /opt/publisher/data
    cp env.example /opt/publisher/deploy/.env   # doplnit hodnoty
    chmod 640 /opt/publisher/deploy/.env; chown root:publisher /opt/publisher/deploy/.env

Hash PINu: `python3 app/auth.py <PIN>`, tajný klíč: `python3 -c "import secrets;print(secrets.token_hex(32))"`.

## 2. Služba a nginx

    cp publisher.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable publisher

Obsah `nginx-location.conf` vložit do HTTPS `server { }` bloku a `nginx -t && systemctl reload nginx`.

## 3. Automatické nasazení z GitHubu

    bash setup-pull-deploy.sh git@github.com:<organizace>/<repo>.git

Skript vytvoří klíč jen pro čtení a vypíše jeho veřejnou část. Ta se vloží do repa na GitHubu v **Settings → Deploy keys** bez oprávnění k zápisu. Pak server každé 2 minuty zkontroluje větev `main`. Když najde nový commit, nasadí jen `scriptorium/app`, restartuje službu a ověří, že odpovídá. Pokud neodpovídá, vrátí předchozí verzi.

Bezpečnost: server se na GitHub připojuje sám a jen pro čtení, GitHub ani nikdo jiný se na server nepřipojuje. Skript i kód patří rootovi, služba běží pod uživatelem `publisher` a zapisovat smí jen do `/opt/publisher/data`.

Ruční nasazení a log:

    systemctl start publisher-deploy
    journalctl -t publisher-deploy -n 20

## 4. Zálohy

Data jsou jen v `/opt/publisher/data`. Doporučená noční záloha mimo server, např.:

    tar czf /backup/scriptorium-$(date +%F).tgz -C /opt/publisher data
