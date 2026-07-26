# TwilioChat

A self-hosted, dockerized messaging app for SMS/MMS via Twilio, styled after the
macOS Messages app and installable as a PWA on mobile. See [PLAN.md](PLAN.md) for
the full architecture and roadmap.

**Status: Phase 4** — messaging core (Twilio webhooks, threading, delivery
status), auth, realtime WebSockets, the Messages-style UI, and the PWA layer
(installable, offline history, offline outbox, push notifications).

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

## Security notes

- This repo is **public**: real credentials belong only in the git-ignored `.env`.
  Use Twilio test credentials and magic numbers (e.g. `+15005550006`) in development.
- CI runs gitleaks; enable GitHub push protection on your fork too.
