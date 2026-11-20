# ShotTracker

Self-hosted tracker for injectable medications in a household: patients, inventory by lot, schedules, the injection log, site rotation, reminders, reports and encrypted backups. Runs as one Docker container (built for TrueNAS SCALE), sits behind a reverse proxy, and keeps everything in a Docker named volume.

> ShotTracker records and reminds. Doses and schedules come from the prescriber.

## What it does

| Area | Features |
| --- | --- |
| **Today** | Every patient's next shots with status (overdue, due now, today, upcoming), one-tap **Log shot**, snooze, stock and refill alerts |
| **Logging** | Pre-filled dose, volume to draw (from the concentration), soonest-expiring usable lot, least-recently-used injection site on a body map; given / skipped / missed with reason, reaction and notes; edits and deletes put stock back |
| **Medications** | Prefilled syringe (default), pen, single-dose vial, multi-dose vial; concentration, route, storage, "good for X days after opening"; prescriber, specialty pharmacy, Rx number, refills left, next shipment |
| **Schedules** | Every X days / weeks / months or chosen weekdays; time of day; "late after" window; fixed calendar or counted from the last shot; dose changes over time (titration or taper); pause |
| **Inventory** | Lots with expiration, quantity and location; multi-dose vials get opened and discard-by dates; carton barcode scanning (GS1 DataMatrix: NDC, lot, expiration); supplies that count down per shot; sharps container fill level; lot lookup for recalls |
| **Reminders** | Day before (with "take it out of the fridge"), morning of, due now, then repeats until logged; per-person quiet hours; snooze |
| **Channels** | Home Assistant phone notifications with **Given now** and **Snooze 1 hour** buttons, email reminders and a daily digest, a private calendar feed, and "next shot" sensors in Home Assistant |
| **Alerts** | Low stock (days of supply), out of stock, expiring and expired lots, opened vials past discard-by, no refills left, late shipment, supplies to reorder, sharps container 80% full |
| **Reports** | Adherence (on time, late, skipped, missed), every shot with lot and site, print / save as PDF for doctor visits, CSV export |
| **People** | Admin, caregiver (manages the patients you tick), patient (sees and logs their own), viewer (read-only) |
| **NFC tags** | Tap a tag on the fridge to open straight to logging that shot; retarget tags any time without rewriting them |
| **Safety** | HTTPS, required two-factor sign-in, activity log of every change, nightly encrypted backups with restore |

## Install on TrueNAS SCALE

1. **Apps → Discover Apps → Custom App → Install via YAML**, paste [`truenas-app.yaml`](truenas-app.yaml).
2. Open `https://<TrueNAS IP>:9743` and accept the certificate warning once (a self-signed certificate made on first start).
3. Create the admin account, add ShotTracker to an authenticator app, and enter the code.
4. Save the 8 recovery codes somewhere safe, such as a password manager.

With Docker Compose instead: `docker compose up -d` using [`docker-compose.yml`](docker-compose.yml).

Updates: the image is pulled again every time the app restarts (`pull_policy: always`).

## First-time setup in the app

1. **Settings → This app:** the address you open ShotTracker at (for example `https://shots.yourdomain.lan`). Notification links and the calendar feed use it.
2. **Settings → Home Assistant:** URL and a long-lived access token (HA → your profile → Security). **Test connection** should list your phones. The "notification buttons link" shows *connected* once ShotTracker is listening for button presses.
3. **Settings → Email** (optional): SMTP server, then **Send me a test email**.
4. **Settings → Backups:** set a passphrase (keep it in your password manager) and press **Back up now**.
5. **Patients → Add patient**, then **Add medication**, **Add schedule**, and on **Inventory**, **Receive** your current stock.
6. **Your name (top right) → Notifications:** pick your phone, set quiet hours, **Send a test**. Optionally make a **calendar link** and subscribe to it on your phone.
7. **Settings → Users:** add your spouse as a caregiver with both patients ticked.

## Reminders

For each scheduled shot, everyone who can log it gets:

| When | Message |
| --- | --- |
| Day before, 7:00 PM | "due tomorrow at …", plus "take it out of the fridge" for refrigerated medications |
| Morning of, 8:00 AM | "due today at …" |
| Due time | "due now" (comes through even in quiet hours) |
| After the "late after" window | "hasn't been logged", repeating every 60 minutes until it's logged or snoozed |

Times and the repeat interval are under **Settings → Reminders**. During a person's quiet hours, everything but "due now" waits until quiet hours end.

On the phone notification:
- **Open** goes straight to the log screen.
- **Given now** logs the shot with the scheduled dose, the soonest-expiring lot and the suggested site. Edit it later if anything differs.
- **Snooze 1 hour** holds the reminders for an hour.

The buttons work through Home Assistant's websocket, so no Home Assistant automation is needed.

**Missed shots:** on a fixed-calendar or weekday schedule, a shot that still isn't logged when the next one comes due is marked *missed*. A schedule "counted from the last shot" just waits.

**Home Assistant sensors** (Settings → Home Assistant): `sensor.shottracker_<patient>_<medication>` holds the next due time (a timestamp, with status, dose, stock and days of supply as attributes). `sensor.shottracker_overdue` counts overdue shots. Use them in dashboards or your own automations. They are refreshed every 5 minutes and after Home Assistant restarts.

## Barcode scanning

**Inventory → Receive → Scan carton barcode** reads the square 2D code (GS1 DataMatrix) on the carton and fills in the lot, expiration date and NDC. If you set the NDC on the medication, ShotTracker warns when a scanned carton doesn't match.
- The camera needs HTTPS, which you get through the proxy or the app's own port.
- On iPhone, scanning uses a reader that's bundled into the Docker image when it's built.
- If the camera can't read the code, type the lot and date, or paste the text from a scanner app.

## NFC tags

Stick an NFC tag on the fridge door, the medication box or the sharps container. Tap it with your phone and ShotTracker opens right where you need it.

| When tapped | Opens |
| --- | --- |
| Log a shot (schedule) | The log screen for that shot, filled in: dose, lot and suggested site. Check it and press Save. |
| Log a shot (medication) | The same, for a medication's current schedule |
| Open Today | Everyone's next shots |
| Open a patient | That patient's page |
| Receive a shipment | Inventory with the "Receive shipment" form open for that medication |

**Set one up:** Settings → NFC tags → **Add tag**. Name it, choose what it opens, then **Next** to get the tag link (`https://<your address>/t/<code>`).
- **Android (Chrome):** press **Write to tag** and hold the tag to the back of the phone.
- **iPhone:** in the free *NFC Tools* app, choose Write → Add a record → URL, paste the link, then Write and hold the tag near the top of the phone.

Any NTAG213/215/216 sticker works.

**Good to know:**
- **Changing a tag:** you can change what a tag opens at any time in ShotTracker without rewriting the tag. Each tag shows how often it was tapped and by whom.
- **What's on the tag:** the tag holds only that link. Opening it still needs a signed-in ShotTracker account with access to that patient, and over VPN or home Wi-Fi only (behind the Nginx allow-list). A lost tag reveals nothing.
- **Locking:** after writing, you can lock the tag in NFC Tools so no one can overwrite it. Locking is permanent, but you can still change what the link opens in ShotTracker.
- **iPhone, opening:** tapping the tag shows a banner, and touching the banner opens Safari. Sign in once in Safari with "keep me signed in". Safari and a home-screen ShotTracker keep separate sign-ins.
- **iPhone, no banner:** a Shortcuts automation (Automation → NFC → *Open URLs*) opens the tag's link without the banner.

## Behind Nginx (VPN only)

Keep ShotTracker on the LAN and reach it from outside over your VPN (WireGuard, Tailscale, UniFi Teleport). Don't use a public port forward.

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name shots.yourdomain.lan;
    ssl_certificate     /etc/nginx/certs/shots.crt;
    ssl_certificate_key /etc/nginx/certs/shots.key;

    # home network and VPN only
    allow 192.168.1.0/24;     # LAN
    allow 10.8.0.0/24;        # VPN clients
    deny  all;

    client_max_body_size 300m;   # restoring a backup uploads the file

    location / {
        proxy_pass https://TRUENAS_IP:9743;
        proxy_ssl_verify off;                 # the app's own certificate is self-signed
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

Then set `TRUST_PROXY` in the app's YAML to the Nginx machine's IP. Only then does ShotTracker read those `X-Forwarded-*` headers, and only from that address.

With **Nginx Proxy Manager**:
- Scheme `https`, forward to `TRUENAS_IP` port `9743`.
- Turn on Websockets Support.
- Attach an **Access List** that allows only your LAN and VPN subnets.
- Add `client_max_body_size 300m;` under Advanced.

## Security

| Area | What ShotTracker does |
| --- | --- |
| Transport | HTTPS (TLS 1.2+), HSTS, strict Content-Security-Policy (no inline scripts), no framing, no referrer |
| Passwords | scrypt hashes, 12 characters minimum |
| Two-factor | Authenticator-app codes (TOTP) required for every account; each code works once; 8 one-time recovery codes |
| Sessions | Random token stored hashed; HttpOnly, Secure, SameSite=Strict cookie; 12-hour idle timeout, or 30 days on a "keep me signed in" device; "sign out everywhere" |
| Brute force | 5 wrong tries locks a user name for 15 minutes; 20 locks an address |
| Changes | Need a custom request header plus a matching Origin (CSRF protection) |
| Access | Caregivers, patients and viewers only ever see the patients they're given |
| At rest | Two-factor secrets and tokens (Home Assistant, SMTP, backup passphrase) encrypted with AES-256-GCM using a key in the volume |
| Backups | AES-256-GCM with a key derived from your passphrase (scrypt), so a backup file is useless without it |
| Notification buttons | Each button is signed, so only ShotTracker's own notifications can log or snooze a shot |
| Calendar feed | A long random link per person; making a new link turns the old one off |
| History | Activity log of sign-ins and every change, with who, when, and the old and new values |
| CSV | Cells that start with `=`, `+`, `-` or `@` are neutralized so a spreadsheet won't run them |

The repo holds code only. No patient data lives here.

## Backups and restore

- A nightly encrypted backup (default 2:30 AM, last 30 kept) is saved in the volume. **Back up now** and **Download** are under Settings → Backups.
- To keep a copy outside the volume too, mount a folder and set `BACKUP_DIR` to it.
- **Restore:** Settings → Backups → pick the `.stbk` file and enter the passphrase it was made with. ShotTracker first saves a copy of the current data, then replaces it and restarts. Docker's restart policy brings it back up.
- On a new install, set up the admin account, then restore. You'll sign in with the accounts from the backup.

## Lost phone or locked out

- Sign in with a recovery code, then make new codes from your account page.
- An admin can open **Users → Edit** and tick "Make them set up two-factor again".

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `TZ` | `America/Chicago` | Time zone for due times and reminders |
| `TRUST_PROXY` | unset | Reverse proxy IPs or IPv4 ranges, comma-separated |
| `HTTPS_PORT` | `8443` | HTTPS port inside the container |
| `HTTP_PORT` | unset (off) | Optional plain-http port |
| `TLS_CERT`, `TLS_KEY` | unset | Your own certificate instead of the self-signed one |
| `BACKUP_DIR` | unset | Also copy each backup to this mounted folder |
| `DATA_DIR` | `/data` | Database, certificate, key and backups (the named volume) |

## Development

Node 22.13 or newer. The server has no npm dependencies.

```
npm test                                   # end-to-end test with a fake Home Assistant and email server
DATA_DIR=./data HTTP_PORT=8080 HTTPS_PORT=0 npm start
```

Every push to `main` runs the tests and publishes `ghcr.io/leonidis2013/shottracker:latest` and `:<version>`.

## Changelog

| Version | Changes |
| --- | --- |
| 1.1.1 | Settings is one screen with tabs: General, Users, NFC tags and Activity (top bar is now Today, Patients, Inventory, Reports, Settings) |
| 1.1.0 | NFC tags: tap a tag to open ShotTracker to a shot's log screen, Today, a patient, or receiving a shipment; write tags from Android Chrome; tap history |
| 1.0.0 | Medications, lots and inventory, schedules with dose changes, shot log with dose math and site rotation, body map, barcode scanning, supplies and sharps, alerts, reminders (Home Assistant with action buttons, email, digest), calendar feed, HA sensors, reports with PDF/CSV, per-patient access and patient logins, encrypted backup and restore |
| 0.1.0 | HTTPS, admin setup, TOTP sign-in, users and roles, patients, encrypted settings, activity log |
