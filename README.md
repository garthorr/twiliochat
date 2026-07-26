# TwilioChat

A self-hosted, dockerized messaging app for SMS/MMS via Twilio, styled after the
macOS Messages app and installable as a PWA on mobile. See [PLAN.md](PLAN.md) for
the full architecture and roadmap.

**Status: complete** (phases 1–5 of [PLAN.md](PLAN.md)) — messaging core
(Twilio webhooks, threading, delivery status), auth, realtime WebSockets, the
Messages-style UI, the PWA layer (installable, offline history, offline outbox,
push notifications), and MMS attachments, contact names, message search,
message sounds, and retry of failed sends.

## Features

- **Threaded SMS/MMS** — one conversation per phone number, like Messages
- **macOS Messages look and feel** — bubble clustering with tails, date
  dividers, delivery states, dark mode, phone-style navigation on mobile
- **Realtime** — inbound messages and delivery updates stream over WebSockets
- **MMS both ways** — inbound media is re-hosted locally and rendered inline
  (tap to open full screen); attach photos to outgoing messages
- **Contacts** — import names from a Google Contacts vCard/CSV export, or
  rename an individual thread; names are used in notifications too
- **Segment counter** — shows cost-relevant SMS segments as you type
- **Search** — filter threads, or search across all message content
- **Message sounds** — synthesized send/receive tones, toggleable
- **Retry** — failed sends show "Not Delivered" with a Try Again button
- **PWA** — installable, reads offline, queues sends made offline, push
  notifications
- **Opt-out aware** — when someone replies STOP, the thread shows a banner and
  the composer is disabled, because Twilio blocks those messages anyway
- **Archive and delete** — including cleanup of stored MMS files
- **Cost and abuse guards** — per-minute and daily send caps, login rate limiting

## Stack

- **server/** — Node 22 + TypeScript + Fastify, Drizzle ORM + PostgreSQL
- **web/** — React 19 + Vite (PWA layer lands in phase 4)
- **Docker** — one `app` container (serves API + built frontend) plus Postgres

## Quick start (Docker)

```sh
cp .env.example .env   # fill in your values — never commit .env
docker compose up --build
```

Then open http://localhost:8080. Database migrations run automatically on start.

## Development

```sh
pnpm install
docker compose up db -d          # just Postgres
DATABASE_URL=postgres://twiliochat:twiliochat@localhost:5432/twiliochat pnpm dev
```

- Web dev server: http://localhost:5173 (proxies `/api` and `/healthz` to :8080)
- API: http://localhost:8080

### Checks

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

### Database migrations

Schema lives in `server/src/db/schema.ts`. After changing it:

```sh
pnpm --filter @twiliochat/server db:generate
```

Generated SQL in `server/drizzle/` is applied automatically at server startup.

## Install as an app (PWA)

Open the app over **HTTPS** (service workers require it, `localhost` excepted):

- **iOS/iPadOS**: Safari → Share → *Add to Home Screen*
- **Android**: Chrome → menu → *Install app*
- **Desktop**: the install icon in the browser's address bar

Once installed you get offline access to conversation history, an offline
outbox (messages composed without a connection are queued and sent on
reconnect), and push notifications.

### Push notifications

Generate a VAPID key pair and put it in `.env`:

```sh
npx web-push generate-vapid-keys
```

Then use the bell button in the sidebar to subscribe. Caveats:

- **iOS requires 16.4+ and the app must be installed to the Home Screen** —
  notifications do not work in the Safari tab.
- Push is disabled entirely when `VAPID_*` is unset; the bell is hidden.
- A message composed while offline shows a send error until the service worker
  replays it in the background; it then appears in the thread normally.

## Contacts

Open the contacts button in the sidebar and upload an export from
contacts.google.com (**vCard** or **Google CSV**). Numbers are normalized to
E.164 and matched to conversations automatically, including threads that don't
exist yet. Only name/number pairs are stored — the export file itself is never
written to disk, and nothing is sent to Google.

A name set on an individual conversation (the pencil in the thread header)
always overrides the imported one.

## Known limitations

- **Group MMS is not supported.** Twilio's Programmable Messaging API — which
  this app is built on — does not offer it; group messaging requires the
  Conversations API. The database schema keys threads by a participant *set*,
  so the groundwork is there if that ever changes.
- Sending photos requires `PUBLIC_URL` to be set, because Twilio fetches the
  media from your server. Those fetches use short-lived signed URLs rather than
  exposing the media directory.
- iMessage-only features (typing indicators, read receipts, reactions) do not
  exist over SMS and are deliberately not faked.

## Security notes

- This repo is **public**: real credentials belong only in the git-ignored `.env`.
  Use Twilio test credentials and magic numbers (e.g. `+15005550006`) in development.
- CI runs gitleaks; enable GitHub push protection on your fork too.
