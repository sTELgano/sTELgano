# Droplet setup — sTELgano step-by-step

Linear walkthrough from a fresh DigitalOcean Ubuntu droplet to a
running sTELgano instance behind Caddy + TLS.

Artifacts it produces on the server:

- `deploy` Linux user with an SSH key and narrow sudo
- `/opt/stelgano/{releases, current, .env}`
- `/etc/systemd/system/stelgano.service`
- `/etc/sudoers.d/stelgano`
- `/etc/caddy/Caddyfile` entry reverse-proxying `stelgano.com` → `127.0.0.1:4000`
- Opened firewall ports: 22, 80, 443

Everything else (the tarballed release, migrations, service bounce) is
then driven by the GitHub Actions workflow in
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) on every
push to `main`.

> Assumes managed Postgres lives elsewhere (DO Managed Database).
> After finishing this guide, add the droplet to your database cluster's
> **Trusted Sources** so the app can connect.

---

## 0. Prereqs

- A fresh Ubuntu 22.04+ droplet with the `ubuntu` user (DO default).
- Your laptop's public SSH key in `/home/ubuntu/.ssh/authorized_keys`
  (DO does this automatically if you selected an SSH key at creation).
- DNS for `stelgano.com` + `www.stelgano.com` A-records pointed at the
  droplet's IP.
- Managed Postgres cluster, with a `DATABASE_URL` you can copy from the
  DO dashboard.

SSH in as `ubuntu`:

```bash
ssh ubuntu@<droplet-ip>
```

## 1. Firewall

Keep SSH, HTTP, HTTPS open. Everything else closed.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
sudo ufw status
```

## 2. Install Caddy

Caddy handles TLS (Let's Encrypt), HTTP→HTTPS redirect, and reverse
proxy — fewer moving parts than nginx + certbot.

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

## 3. Create the deploy user

```bash
sudo adduser deploy
sudo usermod -aG sudo deploy
```

The deploy user is what GitHub Actions SSHes in as (via the key stored
in `DO_SSH_KEY`), and what systemd runs the app under.

Set up SSH access for the GitHub Actions deploy:

```bash
# Still as ubuntu:
sudo -u deploy mkdir -p /home/deploy/.ssh
sudo -u deploy chmod 700 /home/deploy/.ssh
sudo -u deploy touch /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
# Paste the *public* key whose private half is in DO_SSH_KEY:
sudo -u deploy vim /home/deploy/.ssh/authorized_keys
```

> Use a dedicated SSH keypair for CI, not your personal key. Generate
> it locally with `ssh-keygen -t ed25519 -f stelgano-deploy -N ""`, put
> the public half in `authorized_keys` above, and paste the **private**
> half (`stelgano-deploy` file contents) into the `DO_SSH_KEY` GitHub
> Actions secret.

## 4. App directories + env file

```bash
sudo mkdir -p /opt/stelgano/releases
sudo chown -R deploy:deploy /opt/stelgano
sudo -u deploy vim /opt/stelgano/.env
sudo chmod 600 /opt/stelgano/.env
```

Populate `/opt/stelgano/.env` from [.env.example](../.env.example).
Required values:

```
PHX_SERVER=true
PHX_HOST=stelgano.com
SECRET_KEY_BASE=<output of `mix phx.gen.secret`>
DATABASE_URL=postgresql://doadmin:<pass>@private-<cluster>.f.db.ondigitalocean.com:25060/defaultdb
ADMIN_PASSWORD=<strong random value>
PORT=4000
```

Use the **private** Postgres hostname (`private-*.f.db.ondigitalocean.com`)
so traffic stays on DO's internal network. The sTELgano runtime.exs
strips `?sslmode=*` from the URL and enables `ssl: [verify: :verify_none]`
explicitly — no CA cert file needed.

## 5. Systemd unit

Copy the unit template from the repo (the first successful deploy
will place it under `/opt/stelgano/current/deploy/stelgano.service`;
for the very first boot you can also paste it in by hand now):

```bash
sudo vim /etc/systemd/system/stelgano.service
# Paste the contents of deploy/stelgano.service from this repo.

sudo systemctl daemon-reload
sudo systemctl enable stelgano
# Don't start yet — /opt/stelgano/current doesn't exist until the
# first deploy lands.
```

## 6. Sudoers for the deploy user

The deploy workflow needs passwordless sudo for a small, fixed set
of commands. Use `visudo` so the kernel rejects a broken file instead
of locking you out:

```bash
sudo visudo -f /etc/sudoers.d/stelgano
```

Paste:

```
deploy ALL=(ALL) NOPASSWD: /bin/mkdir -p /opt/stelgano/releases
deploy ALL=(ALL) NOPASSWD: /bin/chown -R deploy\:deploy /opt/stelgano
deploy ALL=(ALL) NOPASSWD: /bin/systemctl start stelgano
deploy ALL=(ALL) NOPASSWD: /bin/systemctl stop stelgano
deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart stelgano
deploy ALL=(ALL) NOPASSWD: /bin/systemctl is-active stelgano
deploy ALL=(ALL) NOPASSWD: /bin/systemctl is-active --quiet stelgano
deploy ALL=(ALL) NOPASSWD: /bin/journalctl -u stelgano *
```

```bash
sudo chmod 440 /etc/sudoers.d/stelgano
```

The `\:` escapes the colon (sudoers uses `:` as a field separator).

## 7. Caddyfile

```bash
sudo vim /etc/caddy/Caddyfile
```

Replace the default contents with:

```
stelgano.com, www.stelgano.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:4000

    # Strip the Bandit server banner; a header on every response
    # advertising the library version is reconnaissance value with
    # zero operational benefit.
    header -Server
}
```

Reload:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy
```

Caddy obtains a Let's Encrypt cert automatically the first time
someone hits `https://stelgano.com`.

## 8. GitHub Actions secrets

Repo → Settings → Secrets and variables → Actions → New:

| Secret | Value |
|--------|-------|
| `DO_HOST` | droplet IP or `stelgano.com` |
| `DO_USERNAME` | `deploy` |
| `DO_SSH_KEY` | the **private** half of the deploy keypair (full PEM, including `-----BEGIN` / `-----END` lines) |
| `DO_SSH_PORT` | *(optional, default 22)* |

## 9. First deploy

Push any commit to `main` (or run the workflow manually via
**Actions → Deploy to DigitalOcean → Run workflow**). The workflow:

1. Builds a release in a GH Actions runner (`mix release`).
2. Tars it, scp's it to `/tmp/stelgano.tar.gz` on the droplet.
3. Extracts it into `/opt/stelgano/releases/<timestamp>`.
4. Points `/opt/stelgano/current` at the new directory.
5. Sources `/opt/stelgano/.env` and runs `Stelgano.Release.migrate()`.
6. Starts the systemd unit.
7. Verifies `systemctl is-active stelgano`.

If step 7 fails, the workflow prints the last 30 lines of
`journalctl -u stelgano` — usually enough to see what's wrong.

## 10. Verify

From your laptop:

```bash
curl -I https://stelgano.com
# HTTP/2 200
# server: …   (should NOT show "Bandit/…")

ssh deploy@stelgano.com 'sudo -n systemctl is-active stelgano'
# active
```

In the browser: load `https://stelgano.com/`, navigate to `/steg-number`,
generate a number, open a channel. Check the browser console — no CSP
violations from your own code, and the LiveView WebSocket should connect
within a second or two.

---

## Optional extra hardening

None of these are required to ship, but they're cheap and they
meaningfully raise the bar against automated attackers:

### Disable password login for SSH

```bash
sudo vim /etc/ssh/sshd_config
# Ensure:
#   PermitRootLogin no
#   PasswordAuthentication no
#   PubkeyAuthentication yes
#   AllowUsers ubuntu deploy
sudo systemctl restart sshd
```

Test in a **new** terminal before closing the current one, in case
you've locked yourself out.

### fail2ban for SSH brute-force

```bash
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 3
findtime = 10m
bantime = 1h
EOF
sudo systemctl enable --now fail2ban
```

### Automatic security updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
```

### Journald disk cap

On a small droplet, stop journald from eating the disk:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
sudo tee /etc/systemd/journald.conf.d/size.conf <<'EOF'
[Journal]
SystemMaxUse=500M
SystemKeepFree=1G
MaxFileSec=1week
EOF
sudo systemctl restart systemd-journald
```

---

## Running another app on the same droplet

If you already host another Phoenix app on the same droplet, just
pick a different `PORT` in `/opt/stelgano/.env` and the matching
`reverse_proxy 127.0.0.1:<port>` in the Caddyfile. Everything else
(systemd unit name, sudoers file, `/opt/<app>/...` layout) namespaces
cleanly.

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| `systemctl status stelgano` shows `activating (auto-restart)` in a loop | `sudo journalctl -u stelgano -n 100` — usually a missing/bad env var in `/opt/stelgano/.env` |
| Caddy 502 | App isn't bound to 127.0.0.1:4000. Check `PHX_SERVER=true` is set, and `sudo ss -ltnp \| grep 4000` shows the release listening |
| WebSocket won't connect, CSP clean | `PHX_HOST` in `.env` doesn't match the hostname in the URL bar. Update it and `sudo systemctl restart stelgano` |
| `FATAL: too_many_connections` in journal | DB connection slots exhausted (typical on DO's smallest managed tier, ~22 slots). `POOL_SIZE=5` in `.env` usually fixes it |
| Deploy script fails at `chown` / `mkdir` | Sudoers file missing the exact rule (see §6). `sudo -u deploy sudo -n mkdir -p /opt/stelgano/releases` will reveal the denied command |
