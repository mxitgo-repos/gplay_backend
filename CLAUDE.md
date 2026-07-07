# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firebase **Cloud Functions** backend for **GPlay**, a Flutter social-events app. It owns
Stripe payments & Connect payouts (host onboarding, ticket charges), push notifications
(FCM), IAP receipt validation (Apple/Google), a referral/MLM ambassador system, and admin
/ analytics HTTP endpoints driven from Firestore data.

> **Plain JavaScript, not TypeScript.** All function code lives in a single file,
> [functions/index.js](functions/index.js). There is no build step and no `src/` or `lib/`.
> The repo-root `index.js` / `package.json` (`"testfunc"`) / `package-lock.json` are
> vestigial scraps — only `functions/` is deployed (see `firebase.json`).
> The `functions-repo-CLAUDE.starter.md` doc under [docs/](docs/) describes a *planned*
> TypeScript / `src/`-style layout that **does not match this repo** — ignore its layout/
> language claims; only its contract details matter.

> **The companion Flutter app is the source of truth for client contracts.** It lives at
> `/Users/ponchito/Documents/Codes/gplay_24`. Its `docs/backend_access_control_contract.md`
> and `lib/services/access_control.dart` are the authoritative spec for the §1/§2/§3 access
> matrix; `lib/repositories/payments_repository.dart` defines the Stripe ticket payload
> shapes. When changing any request/response shape or access rule, check (and keep in sync
> with) that repo — the client is already written against these contracts.

## Commands

Run all commands from the `functions/` directory.

```bash
npm install                                 # install dependencies
npm run lint                                # eslint . (also runs as a predeploy hook)
firebase emulators:start --only functions   # serve locally (npm run serve)
firebase functions:shell                     # interactive shell (npm run shell / start)
firebase deploy --only functions             # deploy all (npm run deploy)
firebase deploy --only functions:createPaymentIntent   # deploy a single function
firebase functions:log                       # tail logs (npm run logs)
```

- There is **no unit-test suite**. (`firebase-functions-test` was removed as an unused
  devDependency — its peer deps blocked `firebase-admin` v13 and it dragged in a large
  jest tree. Re-add it *with* `jest` if you ever write tests.) For post-deploy sanity
  checks there is a **Postman smoke-test collection** at
  [docs/gplay-dev.postman_collection.json](docs/gplay-dev.postman_collection.json)
  (read-only requests; `checkEmail` is the best health check — a clean `200` proves
  `admin.auth()` + Firestore work).
- **Deploys are CI/CD-driven.** Merging to `development` auto-deploys to **DEV**
  (`g-play-dd31d`); merging to `main` auto-deploys to **PROD** (`g-play-dev-e4c4c`) — via
  `.github/workflows/deploy-{dev,prod}.yml`. Feature branches → PR into `development`; promote
  with a `development` → `main` PR. Full strategy + first-prod cutover in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Manual fallback (verify target with `firebase use`
  first): [.firebaserc](.firebaserc) aliases `default`/`dev` → DEV and `prod` → PROD, so
  `firebase deploy --only functions` hits DEV and `--project prod` hits PROD.
- Node runtime is pinned to **22** (`functions/package.json` engines + repo-root
  [.nvmrc](.nvmrc)) — the newest runtime Firebase-managed Cloud Functions supports (Node 24
  is *not* deployable here). No region is set, so functions deploy to the default
  `us-central1`. SDKs: `firebase-functions` v7 / `firebase-admin` v13 (peer-clean pair;
  admin v14 would need `--legacy-peer-deps`). Functions v6+ dropped the v1 namespace from
  the package root, so [index.js](functions/index.js) imports it via
  `require("firebase-functions/v1")` — keep that, or every 1st-gen trigger becomes `undefined`.
- Secrets are env vars: `STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`, `APPLE_SHARED_SECRET`
  (documented in [README.md](README.md); the *values* are not in the repo — get them from
  the team / Stripe / App Store Connect; DEV uses `sk_test_…`, PROD `sk_live_…`).
  **Deployed values come from GitHub Actions repo secrets** (`DEV_*` / `PROD_*` prefixes) —
  each deploy workflow writes `functions/.env` just before deploying. A local
  `functions/.env` (gitignored) is only needed for the emulator or a manual deploy, and it
  must live in `functions/`, not the repo root — the Firebase CLI ignores a root `.env`.
- `node-fetch` v3 is ESM-only, so `validateAppleReceipt` loads it via dynamic
  `await import("node-fetch")` — don't convert it to a top-level `require` (it would crash
  on load). `jsonwebtoken` / `jwks-rsa` are declared in `package.json` but currently unused.

## Architecture

Everything is registered in [functions/index.js](functions/index.js) using the **v1
firebase-functions API** (`functions.https.onCall`, `functions.https.onRequest`,
`functions.firestore.document(...)`, `functions.pubsub.schedule(...)`). Function types:

- **Callables** (`onCall`) — invoked from the Flutter app via `httpsCallable('<name>')`;
  caller identity is `context.auth`. Used for Stripe Connect, payments, `getUserData`,
  `processReferral`, receipt validation.
- **HTTP** (`onRequest`) — admin/analytics tools and notification fan-out triggers. These
  set permissive CORS (`Access-Control-Allow-Origin: *`), require `POST`, and handle the
  `OPTIONS` preflight. **They are not auth-gated** — they read the `admins` collection to
  exclude admin UIDs from results rather than to authorize the caller. Treat them as
  internal/admin endpoints.
- **Firestore triggers** — e.g. `event/{eventId}` `onCreate` (notification fan-out by
  interest/state/last-minute) and `user/{userId}` `onUpdate` (`updateBanking`,
  `updateAmbassadorRankings`).
- **Scheduled** (`pubsub.schedule(cron).onRun`) — daily/weekly jobs:
  reminders, profile-verification nudges, `replenishFreeChats` (`0 0 * * *`).

Most heavy `onRequest` functions declare `functions.runWith({memory: "1GB"})`; long jobs
like `eventFinish` add `timeoutSeconds: 540`.

### Shared setup (top of index.js)
- `admin.initializeApp()` (Admin SDK for Firestore, Auth, Messaging).
- `stripe = new Stripe(process.env.STRIPE_SECRET || "placeholder")`.
- `BATCH_SIZE = 500`, `CONCURRENT_LIMIT = 10` for batched Firestore writes / throttled
  notification sends.
- `LEVEL_CONFIG` drives the referral/MLM level thresholds.

### Firestore data model (collections used)
- `user` — primary collection (most reads/writes). Subcollections used by the referral
  system: `level1`, `earningsLevel1`. Verified users have `kyc == true`.
- `event` — events the app sells/promotes; source for notification fan-out.
- `mlmTracking`, `mlmEarnings` — multi-level-marketing referral accounting.
- `eventInterest` — interest-based notification targeting.
- `admins` — UIDs treated as administrators (excluded from user-facing analytics lists).

### Notifications
Push is sent via `admin.messaging().send(message)` per-token, often looped over users with
`CONCURRENT_LIMIT` throttling. There are ~25 `sendNotification*` functions covering events,
chats, requests, rewards, payments, and admin alerts.

### Payments (Stripe)
Stripe Connect **custom accounts** for hosts: `createCustomAccount`, `updateCustomAccount`,
`acceptTos`, `uploadDocument`, `addBankAccount`/`getBankAccount`,
`createPayout`/`createPayoutDestination`, `createTransfer`. Buyer-side:
`createPaymentIntent` / `createPaymentIntentIos`, `confirmPaymentIntent`. IAP validation:
`validateAppleReceipt` (uses `process.env.APPLE_SHARED_SECRET`), `validateGooglePurchase`
(via `googleapis`). Amounts are in **minor units** (cents).

A host's Stripe connected-account id is stored on the host **user doc's `accountId` field —
a `List<String>`** (the app `arrayUnion`s onboarded accounts; the active one is index 0).
Resolve it via `getHostConnectedAccountId(hostRef)`, never from a client-sent value.

### Ticket payments & access enforcement (implemented; §6 + §1/§2/§3)
Added to `index.js`, all reusing the helpers/constants near the bottom of the file:
- `createTicketPaymentIntent` (onCall) — Connect **destination charge** to the host with
  `application_fee_amount = round(priceCents * TICKET_COMMISSION_RATE)` (rate is a TODO
  constant), idempotency key `` `${eventId}:${uid}` ``. Verified (`kyc==true`) callers only.
- `stripeWebhook` (onRequest) — verifies `req.rawBody` against `STRIPE_WEBHOOK_SECRET`;
  fulfills on `payment_intent.succeeded`. The **source of truth** for fulfillment.
- `confirmTicketPurchase` (onCall) — client fallback; same idempotent fulfillment.
- `fulfillTicketPurchase(eventId, uid)` — transaction-based idempotent join (guards on
  `usersPaid`); mirrors a free join, **no gToken deduction**.
- `eventPublicProjection` (`event/{eventId}` onWrite) — maintains the guest-safe
  `events_public/{eventId}` mirror; omits legacy-G-Token (`isSelling && !currency`) /
  closed / private / ended events; free events expose exact time+desc, paid only a bracket.
- `getEventForViewer` (onCall) — the N2/registered read path; returns a level-appropriate
  projection (guest / registered / verified+joined). **Exact time & full description are
  hidden from guests only on *paid* events** — guests see them on free events.

`firestore.rules` (repo root, wired in `firebase.json`) locks `event/{eventId}` to verified
joiners/buyers and opens `events_public`. **Drafted but NOT deployed** — reconcile with the
live console rules first, or the app loses reads/writes.

## Conventions

- **Style:** `eslint-config-google`, double quotes, `max-len` disabled file-wide, arrow
  callbacks preferred. Run `npm run lint` before deploying (it is a predeploy gate).
- **Secrets** come from environment variables (`STRIPE_SECRET`, `STRIPE_WEBHOOK_SECRET`,
  `APPLE_SHARED_SECRET`) — set them in the function runtime, never hardcode or commit. The
  `"placeholder"` fallback for Stripe exists only so the module loads without the secret.
- **Callables** return plain objects; on failure they often return `{success: false, message}`
  rather than throwing — match the surrounding function's style when extending it.
- **`onRequest`** functions must echo the CORS headers and short-circuit `OPTIONS` with 204,
  matching the existing pattern.
- Adding a new function = add a new `exports.<name>` block to `index.js`; there is no
  registry or barrel file to update.
