# Deploying Ledgerly on an Ubuntu server (Contabo, Hetzner, DigitalOcean…)

This guide sets up Ledgerly behind **Caddy**, which gets and renews the HTTPS certificate automatically.
It also adds **nightly backups**. It takes about 15 minutes on Ubuntu 22.04 or 24.04.

```
Internet ──443──▶ Caddy (HTTPS) ──▶ Ledgerly :8080 ──▶ /opt/ledgerly/data/ledgerly.db
```

## 0. Before you start: a domain name
Create a DNS **A record** pointing at your server's IPv4 address (shown in the Contabo customer panel), e.g. `ledger.yourcompany.mg → 203.0.113.10`.
Wait until `ping ledger.yourcompany.mg` answers with that IP.

> No domain yet? Use the free `sslip.io` name for your IP, written with dashes:
> `203-0-113-10.sslip.io`. HTTPS works with it too, and you can switch to a real domain later.

## 1. Prepare the server
```bash
ssh root@YOUR_SERVER_IP

apt update && apt upgrade -y
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443 && ufw --force enable
curl -fsSL https://get.docker.com | sh
```

## 2. Get Ledgerly and configure it
```bash
git clone https://github.com/tonylarren/ledgerly.git /opt/ledgerly
cd /opt/ledgerly
cp .env.example .env
nano .env                       # set DOMAIN=ledger.yourcompany.mg (and SMTP_* if you want)
mkdir -p data backups && chown 1000:1000 data   # Ledgerly runs as uid 1000 inside the container
```
If the GitHub repository is private, `git clone` asks for a username and password. Use a GitHub
personal access token as the password.

## 3. Start it
```bash
docker compose up -d --build
docker compose ps               # both services should be "running" / "healthy"
docker compose logs -f caddy    # watch for "certificate obtained successfully", then Ctrl+C
```

## 4. Create your administrator account right away
Open `https://ledger.yourcompany.mg`. **The first account registered becomes the administrator**, so do this before sharing the address.
Then:
- create your organisations (Ariary organisations get the Madagascar payroll and `fr-MG` formatting)
- set up **Settings → Email** and **Settings → Currencies**
- add colleagues under **Settings → Members**

Public sign-up stays disabled.

## 5. Backups
```bash
chmod +x deploy/backup.sh
./deploy/backup.sh              # test once: creates backups/ledgerly-YYYY-MM-DD_HHMM.db.gz
(crontab -l 2>/dev/null; echo "30 2 * * * /opt/ledgerly/deploy/backup.sh >> /var/log/ledgerly-backup.log 2>&1") | crontab -
```
This takes a consistent snapshot every night at 02:30 (server time) and keeps 30 days.

**Also keep a copy off the server.** If the server is lost, so are backups stored on it. Either:
- copy them to your PC now and then: `scp root@YOUR_SERVER_IP:/opt/ledgerly/backups/*.gz .`
- or sync them to object storage with `rclone`
- or enable Contabo's own snapshots or backups

## Everyday operations
| Task | Command (in `/opt/ledgerly`) |
|---|---|
| Update to the latest version | `git pull && docker compose up -d --build` |
| View logs | `docker compose logs -f ledgerly` |
| Restart | `docker compose restart ledgerly` |
| Stop / start everything | `docker compose down` / `docker compose up -d` |
| Download a backup from the web UI | Administration → *Download backup* |

The database migrates itself on start-up after an update. Your data is kept.

## Restoring a backup
```bash
cd /opt/ledgerly
docker compose stop ledgerly
gunzip -c backups/ledgerly-2026-10-12_0230.db.gz > data/ledgerly.db
rm -f data/ledgerly.db-wal data/ledgerly.db-shm
chown 1000:1000 data/ledgerly.db
docker compose start ledgerly
```

## Troubleshooting
- **No HTTPS certificate:**
  - check that the DNS record points at this server and that ports 80 and 443 are open (`ufw status`)
  - read `docker compose logs caddy`
- **Ledgerly keeps restarting, with `unable to open database file` in its logs:** the `data` folder isn't owned by uid 1000. Run `chown -R 1000:1000 data`, then `docker compose restart ledgerly`.
- **Emails fail:** use port 587 (STARTTLS) or 465 (TLS). Many providers block outgoing port 25. Use the "Send test" button in Settings → Email.
- **Port 8080 isn't reachable from outside:** that's intended. Only Caddy is exposed, on ports 80 and 443.
