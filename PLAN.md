# TwilioChat — Build Plan

A dockerized, self-hosted messaging app that sends and receives SMS/MMS through Twilio,
presents them as threaded conversations, and looks and behaves as much like the macOS
**Messages** app as possible. Installable as a PWA on mobile.

---

## 1. What we're building

- **One thread per counterpart** — exactly like Messages: a conversation is keyed by the
  remote phone number (or group of numbers for group MMS). All inbound/outbound texts with
  that number appear in one scrollable thread.
- **Web client styled after macOS Messages** — sidebar of conversations on the left,
  active thread on the right; blue outgoing bubbles, gray incoming bubbles; delivery
  status; timestamps that appear on scroll/hover; unread badges.
- **Real-time** — inbound messages from Twilio webhooks are pushed to connected clients
  over WebSockets instantly; outbound status callbacks (queued → sent → delivered/failed)
  update the bubble state live.
- **PWA** — manifest + service worker so it installs to the home screen on iOS/Android,
  works offline for reading history, and (where supported) receives Web Push notifications
  for new messages.
- **Dockerized** — one `docker compose up` brings up the app and its database.

### Explicit non-goals (SMS can't do these)
- iMessage-only features: typing indicators from the remote party, read receipts from the
  remote party, tapbacks/reactions, editing/unsending. We can *render* tapback-style
  reactions Android users send as text ("Loved '…'") but can't originate real ones.

---

## 2. Architecture

```
                 ┌─────────────────────────────────────────┐
   Twilio  ───▶  │  backend (Node.js / Fastify)            │
  webhooks       │  • POST /webhooks/inbound   (new SMS)   │
                 │  • POST /webhooks/status    (delivery)  │
                 │  • REST API  /api/*                     │
                 │  • WebSocket /ws  (real-time fan-out)   │
                 │  • Web Push (VAPID) notifications       │
                 │  • serves the built PWA (static)        │
                 └──────────────┬──────────────────────────┘
                                │
                 ┌──────────────▼──────────────┐
                 │  PostgreSQL                 │
                 │  conversations / messages / │
                 │  attachments / push_subs    │
                 └─────────────────────────────┘
```

- **Backend:** Node.js 22 + TypeScript + Fastify. Twilio Node SDK for sending;
  webhook signature validation (`X-Twilio-Signature`) on all Twilio-facing routes.
- **Frontend:** React 19 + TypeScript + Vite. `vite-plugin-pwa` (Workbox) for the
  service worker and manifest. Plain CSS (or CSS modules) tuned to mimic Messages —
  no heavy UI framework needed.
- **Database:** PostgreSQL 16 (via docker compose). Drizzle ORM for schema + migrations.
- **Real-time:** native WebSockets (`@fastify/websocket`); clients subscribe once and
  receive `message.new`, `message.status`, `conversation.updated` events.
- **Single container serves everything** — the frontend is built into static assets and
  served by the backend, so only one port needs exposing and the PWA origin matches the
  API origin (required for service worker scope).

### Why not Twilio Conversations API?
Programmable Messaging (plain SMS webhooks) is the better fit: we own threading, storage,
and history; Conversations adds cost and complexity aimed at multi-channel chat apps and
doesn't buy us anything for a single-user Messages clone.

---

## 3. Data model

```sql
conversations
  id            uuid pk
  participants  text[]      -- E.164 numbers, sorted; unique index (threading key)
  display_name  text        -- optional contact name override
  last_message_at timestamptz
  unread_count  int default 0
  archived      bool default false

messages
  id            uuid pk
  conversation_id uuid fk
  twilio_sid    text unique     -- idempotency for webhook retries
  direction     'inbound' | 'outbound'
  body          text
  status        'receiving'|'queued'|'sent'|'delivered'|'failed'|'received'
  error_code    text            -- Twilio error on failure
  created_at    timestamptz

attachments
  id, message_id fk, url, content_type, size
  -- MMS media is downloaded from Twilio and re-hosted locally (Twilio URLs expire)

push_subscriptions
  id, endpoint unique, keys_p256dh, keys_auth, created_at

contacts (optional, phase 5)
  phone e164 unique, name
```

Threading rule: on inbound SMS, normalize `From` to E.164, look up a conversation whose
`participants = [that number]`, create it if missing, append the message. Group MMS uses
the sorted set of all non-self participants as the key.

---

## 4. UI spec — matching macOS Messages

**Layout**
- Two-pane: 320 px sidebar + thread view. On mobile (< 700 px) the panes become a
  navigation stack (list → thread with back swipe), matching Messages on iPhone.
- Sidebar rows: avatar circle (initials, colored by hash of number), bold contact
  name/number, one-line last-message preview, relative timestamp, blue unread dot.
- Search field at the top of the sidebar filtering threads by name/number/content.
- "New message" compose button opening a To: field with number entry.

**Thread view**
- Bubbles: outgoing `#1982FC → #0A7CFF` gradient blue, white text, right-aligned;
  incoming `#E9E9EB` gray (dark mode `#3B3B3D`), left-aligned. 18 px corner radius with
  the small tail on the last bubble of a run.
- Message grouping: consecutive messages from the same side within ~60 s cluster
  tightly; larger gaps insert a centered date/time divider ("Today 2:41 PM").
- Delivery state under the last outgoing bubble: "Sending…", "Delivered", or red
  "Not Delivered ⓘ" with tap-to-retry.
- MMS images render inline in the bubble; tap to view full-screen.
- Composer: pill-shaped input that grows with content, send button appears as the blue
  ↑ circle when there's text, Enter to send / Shift+Enter for newline on desktop.
- Sounds: the classic sent "swoosh"-style and received "ding"-style cues (original,
  royalty-free audio assets — not Apple's).
- Full light/dark mode following `prefers-color-scheme`.

**PWA behavior**
- `manifest.webmanifest`: `display: standalone`, theme color matching the toolbar,
  maskable icons (192/512), iOS `apple-touch-icon` + splash meta tags.
- Service worker: precache the app shell; runtime cache for API responses (stale-while-
  revalidate) so history is readable offline; queue outbound sends made while offline
  (Workbox Background Sync) and flush on reconnect.
- Web Push: notify on inbound messages when the app isn't focused (Android + iOS 16.4+
  home-screen installs). Notification tap deep-links to the thread.

---

## 5. Security

- **Twilio webhook validation** on `/webhooks/*` — reject anything failing signature check.
- **App auth**: this app can send real SMS from your number, so it must not be open.
  Single-user password login → httpOnly session cookie; all `/api/*` and `/ws` require it.
  (Simple and sufficient for a personal deployment; OIDC could come later.)
- **Public-repo hygiene** — this repository is public, so nothing sensitive may ever be
  committed: secrets (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
  `SESSION_SECRET`, `APP_PASSWORD`, `VAPID_*`) live only in a git-ignored `.env` consumed
  by compose, with a placeholder-only `.env.example` committed. `.gitignore` from day one
  also excludes the media volume, DB dumps, and logs (message content = personal data).
  Docs and tests use obviously fake numbers (`+15005550006`, Twilio's magic test numbers)
  and never a real personal phone number. Add gitleaks (or GitHub secret scanning push
  protection) to CI so a leaked credential fails the build.
- Rate-limit outbound sends as a cost guard.

---

## 6. Docker & deployment

```yaml
# docker-compose.yml
services:
  app:        # multi-stage build: (1) build frontend, (2) build backend, (3) slim runtime
    build: .
    ports: ["8080:8080"]
    env_file: .env
    depends_on: [db]
    volumes: ["media:/data/media"]   # re-hosted MMS attachments
  db:
    image: postgres:16-alpine
    volumes: ["pgdata:/var/lib/postgresql/data"]
```

- Migrations run automatically on container start.
- Webhooks need a public HTTPS URL: document both options — a reverse-proxied real
  domain (Caddy/Traefik) for production, and an `ngrok`/`cloudflared` sidecar profile in
  compose for local development. A small setup script (or startup task) points the Twilio
  number's `SmsUrl`/`StatusCallback` at `${PUBLIC_URL}` via the Twilio API.
- Healthcheck endpoint `/healthz` wired into compose.

---

## 7. Build phases

| Phase | Deliverable |
|---|---|
| **1. Skeleton** | Repo scaffolding (pnpm workspaces: `server/`, `web/`), Dockerfile + compose, DB schema/migrations, health check, CI (lint + typecheck + test) |
| **2. Messaging core** | Inbound webhook → persist + thread; outbound send via REST API; status callbacks; webhook signature validation; idempotency; unit tests with mocked Twilio |
| **3. Real-time + UI** | WebSocket fan-out; full Messages-style UI (sidebar, thread, composer, grouping, delivery states, dark mode); auth/login |
| **4. PWA** | Manifest, service worker, offline history, background-sync outbox, install polish on iOS/Android, Web Push notifications |
| **5. Finish** | MMS attachments (inbound media re-hosting + outbound picture sending), contact names, thread search, sounds, retry-failed-send, unread/badge counts, README with Twilio + deployment walkthrough |

Each phase lands as a working, testable increment on this branch.

---

## 8. Key risks / notes

- **A2P 10DLC**: US long-code numbers require campaign registration to send SMS reliably;
  the README must call this out (toll-free or a registered number works too).
- **iOS PWA push** requires iOS 16.4+ *and* the app added to the home screen; in-browser
  Safari won't get pushes. WebSocket + in-app notifications cover the rest.
- **Twilio media URLs expire / require auth** — hence downloading MMS media to the
  `media` volume at webhook time.
- **Apple trade dress**: mimic the layout/feel, but use original icons, sounds, and app
  name to stay clean.
