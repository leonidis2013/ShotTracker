# ShotTracker

Self-hosted tracker for injectable medications in a household: patients, inventory by lot, schedules, the injection log, site rotation and reminders. Runs as one Docker container (built for TrueNAS SCALE), sits behind a reverse proxy, and keeps everything in a Docker named volume.

> ShotTracker records and reminds. Doses and schedules come from the prescriber.

**Version 0.1.0** is the secure base: HTTPS, admin setup, required two-factor sign-in, users and roles, patients, encrypted settings and an activity log. See the roadmap below for what comes next.

## Install on TrueNAS SCALE

1. **Apps → Discover Apps → Custom App → Install via YAML**, paste [`truenas-app.yaml`](truenas-app.yaml).
2. Open `https://<TrueNAS IP>:9743` and accept the certificate warning once (it's a self-signed certificate made on first start).
3. Create the admin account, then add ShotTracker to an authenticator app and enter the code.
4. Save the 8 recovery codes somewhere safe, such as a password manager.

With Docker Compose instead: `docker compose up -d` using [`docker-compose.yml`](docker-compose.yml).

Updates: the image is pulled again every time the app restarts (`pull_policy: always`).

## Behind a reverse proxy

- Point the proxy at `https://<host>:9743`. Turn off certificate verification for this upstream, or give the app your own certificate with `TLS_CERT` and `TLS_KEY` (paths inside the container).
- Set `TRUST_PROXY` to the proxy's IP address or range (for example `192.168.1.10` or `172.16.0.0/12`). Only then does the app read `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`, and only from that address.
- The proxy must pass the `Host` header through (or set `X-Forwarded-Host`), because changes are refused when the browser's `Origin` doesn't match.
- Recommended: keep it on the LAN and reach it from outside over a VPN (WireGuard, Tailscale, UniFi Teleport) rather than a public port forward.
- If your proxy can only talk plain http to the app, set `HTTP_PORT` and publish that port only to the proxy.

## Security

| Area | What ShotTracker does |
| --- | --- |
| Transport | HTTPS (TLS 1.2+), HSTS, strict Content-Security-Policy (no inline scripts), no framing, no referrer |
| Passwords | scrypt hashes, 12 characters minimum |
| Two-factor | Authenticator-app codes (TOTP) required for every account; each code works once; 8 one-time recovery codes |
| Sessions | Random token stored hashed; cookie is HttpOnly, Secure, SameSite=Strict; 12-hour idle timeout, or 30 days on a "keep me signed in" device; "sign out everywhere" |
| Brute force | 5 wrong tries locks a user name for 15 minutes; 20 locks an address |
| Changes | Need a custom request header plus a matching Origin (CSRF protection) |
| At rest | Two-factor secrets and tokens (Home Assistant, ntfy, SMTP) encrypted with AES-256-GCM using a key in the volume |
| History | Activity log of sign-ins and every change, with who and when |
| Roles | Admin, caregiver (manages patients), viewer (read-only) |

The repo holds code only. No patient data lives here.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TZ` | `America/Chicago` | Time zone shown in the app |
| `TRUST_PROXY` | unset | Reverse proxy IPs or IPv4 ranges, comma-separated |
| `HTTPS_PORT` | `8443` | HTTPS port inside the container |
| `HTTP_PORT` | unset (off) | Optional plain-http port |
| `TLS_CERT`, `TLS_KEY` | unset | Your own certificate instead of the self-signed one |
| `DATA_DIR` | `/data` | Where the database, certificate and key live (the named volume) |

## Lost phone or locked out

- Sign in with a recovery code, then make new codes from your account menu.
- An admin can open **Users → Edit** and tick "Make them set up two-factor again".

## Roadmap

| Version | Delivers |
| --- | --- |
| 0.1.0 | Docker image, HTTPS, admin setup, TOTP sign-in, users and roles, patients, encrypted settings, activity log |
| 0.2.0 | Medications, lots and inventory, schedules, one-tap shot log, site rotation, dose math |
| 0.3.0 | Reminders: Home Assistant push with action buttons, ntfy, email, escalation; calendar feed; HA sensors |
| 0.4.0 | Barcode scanning, supplies, refill and expiry alerts, reports, PDF/CSV export |
| 1.0.0 | Per-patient caregiver access, encrypted backup and restore, polish |

## Development

Node 22.13 or newer, no npm dependencies.

```
npm test                                   # end-to-end smoke test
DATA_DIR=./data HTTP_PORT=8080 HTTPS_PORT=0 npm start
```

Every push to `main` runs the tests and publishes `ghcr.io/leonidis2013/shottracker:latest` and `:<version>`.
