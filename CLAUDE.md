# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Firebase **Cloud Functions** backend for **GPlay**, a Flutter social-events app. It owns
Stripe payments & Connect payouts (host onboarding, ticket charges), push notifications
(FCM), IAP receipt validation (Apple/Google), a referral/MLM ambassador system, and admin
/ analytics HTTP endpoints driven from Firestore data.

> **Plain JavaScript, not TypeScript.** All function code lives in a single file,
> [functions/index.js](functions/index.js). There is no build step and no `src/` or `lib/`.
> Only `functions/` is deployed (see `firebase.json`). The repo-root `index.js` is an empty
> vestigial scrap, but the repo-root `package.json` (still named `"testfunc"`, ESM) is **not**
> — it now owns the test harness (`vitest`, `@firebase/rules-unit-testing`, `firebase`) and
> the `test` scripts. Two separate `node_modules` trees: root (tests) and `functions/` (runtime).
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

Function commands run from the `functions/` directory:

```bash
npm install                                 # install runtime dependencies
npm run lint                                # eslint . (also runs as a predeploy hook)
firebase emulators:start --only functions   # serve locally (npm run serve)
firebase functions:shell                     # interactive shell (npm run shell / start)
firebase deploy --only functions             # deploy all (npm run deploy)
firebase deploy --only functions:createPaymentIntent   # deploy a single function
firebase functions:log                       # tail logs (npm run logs)
```

Test commands run from the **repo root** (its own `npm install` first):

```bash
npm test                    # firestore.rules suite (test/rules/**, Firestore emulator only)
npm run test:watch          # same, vitest watch mode
npm run test:functions      # functions suite (test/functions/**, Firestore + functions emulators)

# Single file / single test — the wrapper ignores extra args, so call emulators:exec directly
# (use `npx --yes firebase-tools` if there is no global `firebase`; `npx firebase` is a different package):
firebase emulators:exec --only firestore --project gplay-rules-test "vitest run test/rules/event_chat.test.js -t 'banned'"
firebase emulators:exec --only firestore,functions --project gplay-rules-test "vitest run --config vitest.functions.config.js test/functions/redeem_benefit.test.js"
```

Tests use the fake project id `gplay-rules-test` (Firestore emulator on `:8080`, functions on
`:5001`) and run files **serially** — every suite calls `clearFirestore()` on the shared
emulator, so parallel files cause spurious "lock timeout" failures that look like rule bugs.
`functions/.env.gplay-rules-test` (committed, no secrets) overrides `functions/.env` for that
project only, setting `STRIPE_SECRET=placeholder` so the emulator never reaches real Stripe.
If `:8080` is taken (e.g. by Docker), run `emulators:exec` with `--config` pointing at a copy of
`firebase.json` with a different port; `test/rules/helpers.js` follows the exported
`FIRESTORE_EMULATOR_HOST`. The functions suite's `:5001` URL is still hardcoded.

- **Firestore rules have a real test suite** — `npm test` (81 assertions, ~3 s), running
  `vitest` against the Firestore emulator via `@firebase/rules-unit-testing`. It covers the
  `eventChat` / `benefitRedemptions` allow-deny matrix, the `events_public` and `event`
  commission-field rules, baseline non-regression for the
  legacy collections, rule precedence, and the three engine assumptions the membership
  rules rest on (arrayUnion visible in `request.resource.data`, `hasAny()` over
  reference-typed `participantsRef`, `get()`-returns-null). **Run it after any edit to
  `firestore.rules`** — that file is the only thing between the event chat and the
  internet, and a mistake there is global and instant.
  - `@firebase/rules-unit-testing` is **not** the package removed below.
    `firebase-functions-test` was dropped for blocking `firebase-admin` v13; this one is a
    thin client that talks to the emulator over HTTP and has no `firebase-admin` peer at
    all, so that conflict does not apply. Don't "tidy" it away.
  - The emulator needs a JDK and macOS ships none, so `scripts/run-rules-tests.mjs` falls
    back to Android Studio's bundled JBR (present on any machine that builds the Flutter
    app). Override with `JAVA_HOME`.
- `npm run test:functions` additionally starts the **functions** emulator and covers the
  §5/§7 backend and Task C end-to-end (24 assertions, ~35 s), so it stays out of the default loop:
  - **Task C `createTicketPaymentIntent` commission waiver** — credit spent per event (not per
    ticket), expiry by `endPremium`, a hand-granted plan with no `endPremium`, non-Premium hosts,
    free events, and a concurrent first-ticket race. The Stripe call always fails here (placeholder
    key), but the claim transaction commits before it, so the decision is observable. The fee
    *amount* is not; verify that in the Stripe test dashboard on DEV.
  - **B4 `cleanupDeletedEvent`** — the full cascade (chat, messages, pushState, all five
    subcollections), plus an event that never had a chat.
  - **B2 `eventChatMessagePush`** — recipient resolution (sender/banned/blockers excluded,
    **muted deliberately kept**), the 2-minute per-user cooldown, the announcements-mode
    bypass, and the four early exits. FCM can't deliver against the emulator, but
    `pushState/state.lastPushAt` is written *before* the send, so the whole decision is
    observable.
  - **B5 `redeemEventBenefit`** — the balance/verification/membership gates, exact
    1-G-Shard deduction, code format, the `transactions` receipt, and single-use.
    Callables are driven over HTTP with an **unsigned JWT** (`Authorization: Bearer`); the
    emulator decodes without verifying, which avoids needing the auth emulator too.
  - **B1 is not covered** — `joinEventChatBestEffort` is only reachable through
    `fulfillTicketPurchase`, which needs a real Stripe PaymentIntent. Verify on DEV.
  - The run logs unhandled errors from *unrelated* pre-existing `event/{eventId}` triggers
    that dereference optional fields without guarding — `sendNotificationByInterest`,
    `sendNotificationByState`, and `sendNotificationLastMinutes` (unguarded
    `eventData.startDate.toDate()`). Harmless in production only because the client always writes
    those fields.
- There is still **no unit-test suite for the functions' own logic**.
  (`firebase-functions-test` was removed as an unused devDependency — its peer deps blocked
  `firebase-admin` v13 and it dragged in a large jest tree. Re-add it *with* `jest` if you
  ever write those.) For post-deploy sanity checks there is a **Postman smoke-test
  collection** at [docs/gplay-dev.postman_collection.json](docs/gplay-dev.postman_collection.json)
  (read-only requests; `checkEmail` is the best health check — a clean `200` proves
  `admin.auth()` + Firestore work).
- **Deploys are CI/CD-driven.** Merging to `development` auto-deploys to **DEV**
  (`g-play-dd31d`); merging to `main` auto-deploys to **PROD** (`g-play-dev-e4c4c`) — via
  `.github/workflows/deploy-{dev,prod}.yml`. Feature branches → PR into `development`; promote
  with a `development` → `main` PR. Full strategy + first-prod cutover in
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Manual fallback (verify target with `firebase use`
  first): [.firebaserc](.firebaserc) aliases `default`/`dev` → DEV and `prod` → PROD, so
  `firebase deploy --only functions` hits DEV and `--project prod` hits PROD.
  The DEV pipeline was **validated end-to-end on 2026-07-07**. The CI service account needs
  the **seven** IAM roles in DEPLOYMENT.md §1 (the first four alone fail with 403s).
  `workflow_dispatch` (manual run) only works once the workflow file exists on `main` —
  until the first PROD cutover, trigger DEV deploys by merging a change touching
  `functions/**`, or re-run a prior run with `gh run rerun <id>`.
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
  system: `level1`, `earningsLevel1`. Verification state lives in `verificationLevel`
  (`"none"`/`"phone"`/`"id"`), with legacy `kyc == true` as a fallback — see the trust
  ladder below. Hosts carry `accountId` (Stripe Connect, a list).
- `event` — events the app sells/promotes; source for notification fan-out. Joiners are in
  `participantsRef` (refs), ticket buyers in `usersPaid` (uids).
- `events_public` — guest-safe mirror of `event`, maintained by the `eventPublicProjection`
  trigger. Never write it from a client or another function.
- `eventChat/{eventId}` — **top-level**, doc id == event id (not a subcollection of `event`).
  `participants`/`mutedIds`/`bannedIds` are uid **strings**; `hostId` is a uid string even
  though `event.hostRef` is a DocumentReference. Subcollections: `messages` (client-written,
  body field is `content`, not `body`) and `pushState` (server-only, B2 cooldown).
- `event/{eventId}/benefitRedemptions/{uid}` — doc id == uid, which makes one-redemption-per-
  user a database invariant. `status` goes `active` → `used` (terminal).
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
  constant), idempotency key `` `${eventId}:${uid}` `` (the customer is keyed
  `` `customer:${eventId}:${uid}` `` so a retry sends identical params). Requires phone-or-ID
  verification (see the trust ladder below), not full KYC.
  - **Task C — Premium commission-free sales:** before any Stripe call,
    `claimCommissionWaiver(eventRef, hostRef)` runs a transaction. If the event already has
    `commissionWaived`, or the host `hasActivePremium()` (`isPremium` and `endPremium` absent or
    in the future, by server time) with `salesPremium > 0`, the fee is **0**. Claiming sets
    `event.commissionWaived/commissionWaivedAt` and decrements `user.salesPremium`, **once per
    event**, never per ticket. The waiver stays on the event even after the plan expires or the
    payment fails (an accepted trade-off). PaymentIntent metadata carries
    `commissionWaived: "true"|"false"`. The client only spends `salesPremium` on legacy
    G-Token events at `eventFinish`, so fiat credits are spent only here. `hasActivePremium` mirrors
    `premium_policy.dart` in the Flutter repo.
- `stripeWebhook` (onRequest) — verifies `req.rawBody` against `STRIPE_WEBHOOK_SECRET`;
  fulfills on `payment_intent.succeeded`. The **source of truth** for fulfillment. A DEV
  endpoint is registered in the Stripe **test** dashboard. Safe probes: an unsigned `POST`
  returns `400 Webhook Error` (proves it's deployed and verifying), and the dashboard's
  "Send test event" exercises the signed path — test events carry no `eventId`/`uid`
  metadata, so the handler logs a warning and returns 200 without touching any data. Only
  a real app purchase exercises the metadata-bearing fulfillment path.
- `confirmTicketPurchase` (onCall) — client fallback; same idempotent fulfillment.
- `fulfillTicketPurchase(eventId, uid)` — transaction-based idempotent join (guards on
  `usersPaid`); mirrors a free join, **no gToken deduction**.
- `eventPublicProjection` (`event/{eventId}` onWrite) — maintains the guest-safe
  `events_public/{eventId}` mirror; omits legacy-G-Token (`isSelling && !currency`) /
  closed / private / ended events; never carries exact time or description (only
  `generalDate`), and paid events add a price bracket.
- `getEventForViewer` (onCall) — the N2/registered read path; returns a level-appropriate
  projection. **Exact time & full description are hidden from guests on *all* events**, per
  the customer direction of 2026-06-17 that `access_control.dart` implements. The Flutter
  repo's `backend_access_control_contract.md` table still says "N1 free ✓"; it is stale.

### Event chat & benefits (§5/§7 — the "client cannot do this" items)
- `joinEventChatBestEffort(eventId, uid, event)` — arrayUnions a fiat buyer into
  `eventChat/{eventId}.participants`, skipping anyone in `bannedIds`, and creates the chat doc
  if the client never did. Called from `fulfillTicketPurchase` **after** its transaction, never
  inside it (`eventChat` is rewritten on every message send; contending there would surface as
  an error to a buyer who has already been charged). Never throws.
- `eventChatMessagePush` (`eventChat/{eventId}/messages/{messageId}` onCreate) — push fan-out.
  Must be a trigger: the client's `EventChatRepository` has no HTTP/callable client, so an
  endpoint would never be invoked. Recipients = `participants` − sender − `bannedIds` −
  anyone whose `user/{uid}.usersRef` (an array of **DocumentReference**, so compare `.path`)
  contains the sender. `mutedIds` is *not* filtered — mute means "cannot post", not "cannot
  hear". A 2-min per-user cooldown, claimed transactionally in
  `eventChat/{id}/pushState/state`, caps banners *and* keeps `user.notifications` (an unbounded
  array in a 1 MB doc) from exploding; announcements-mode host posts bypass it.
- `redeemEventBenefit` (onCall) — server-side mirror of the client's redemption transaction:
  1 G-Shard debit + receipt, `BEN-XXXXX-XXXXX` code from `crypto.randomInt`, redemption doc id
  == uid. Returns `{success, reason, code?, balance?, redemption?}` rather than throwing.
  **Dormant until the client swaps `EventBenefitRepository.redeemBenefit` to call it**, and it
  buys little until `user` docs stop being client-writable.
- `cleanupDeletedEvent` (`event/{eventId}` onDelete) — `recursiveDelete` over
  `eventChat/{eventId}` (sweeps `messages` + `pushState`) and the event's `question`, `comment`,
  `answer`, `participants`, `benefitRedemptions`. One `BulkWriter` serves all six because
  `recursiveDelete` only *flushes* it.
- Shared helpers: `trustLevelOf(userSnap)`, `isPhoneOrIdVerified(level)`, `isPaidEvent(event)`,
  `hasJoinedOrPaid(event, uid)`. Note `hasJoinedOrPaid` matches the client (paid events count
  `usersPaid` only) while `getEventForViewer` deliberately keeps its looser OR-of-both-arrays
  check — see the comment there before "fixing" the difference.

#### Trust ladder (`verificationLevel`, not `kyc`)
The user doc's **`verificationLevel`** string is the authority: `"none"` → `registered`,
`"phone"` → `phoneVerified` ("Verified-lite"), `"id"` → `verified`. The legacy boolean
`kyc == true` is still honored as a fallback for docs written before the field existed
(treat it as `"id"`). Anonymous auth (`provider === "anonymous"`) → `guest`.

Both **buying a ticket** (`createTicketPaymentIntent`) and the **Nivel 3 unlock**
(`getEventForViewer`, which additionally requires the caller to be in `participantsRef` or
`usersPaid`) need only **phone-or-ID** — do *not* gate new ticket/event-access code on
`kyc === true` alone. This mirrors `access_control.can()` in the Flutter repo
(`lib/services/access_control.dart` + `docs/backend_access_control_contract.md`); that file
is the truth table, keep the two in sync.

### Firestore security rules & indexes
`firestore.rules` (repo root, wired in `firebase.json`) has tight per-collection rules for
`eventChat/**` and `event/{id}/benefitRedemptions/**`; `events_public` (world-readable,
never client-writable); `event/{id}` (baseline access, except that clients may not create or
change `commissionWaived`/`commissionWaivedAt`); and a permissive **require-auth baseline**
for everything else. **None of it is deployed yet** — the live console
rule in both projects is still `allow read, write: if true`, i.e. open to the internet.
Deploy the baseline alone first, smoke-test, then this file; the in-file plan lists the flows.

Three things to know before editing it:
- **Never re-introduce `match /{document=**}`.** Firestore grants access if *any* matching
  rule allows it, and a recursive wildcard cannot be negated — it would silently override
  every tight rule. The baseline is therefore expressed at fixed depths (2/4/6 segments) with
  the protected roots excluded **by name** (`collection != "eventChat"`). For the same reason,
  never add `match /event/{id}/{sub=**}` — it would re-open `benefitRedemptions`.
- The granular trust-ladder lock on `event/{id}` (full doc only for verified joiners, brief
  B3) is still intentionally **absent**. The `event` match block only protects the two
  server-written commission fields. `user.isPremium/endPremium/salesPremium` remain
  client-writable, because the app's Premium purchase writes them. The client has no ownership model: it writes global
  counter singletons, other users' `user` docs, event subcollections, and 1:1 chats addressed
  by a caller-supplied id. Enforcing ownership breaks those flows until they move into Cloud
  Functions — a separate project, not a rules edit. `eventChat`/`benefitRedemptions` could be
  locked down precisely because they are new and no legacy flow depends on them.
- Message and redemption **deletes are host-allowed, not `if false`**, because the client's
  `deleteSubcollectionsEvent` still deletes them during event deletion and rethrows on
  failure. Tighten only after the client drops that loop in favour of `cleanupDeletedEvent`.

`firestore.indexes.json` is the union of what was already live in **both** projects plus the
`eventChat` composite (`participants` array-contains + `lastMessageTimestamp` desc) the
Messages tab needs. Regenerate with `firebase firestore:indexes --project <id>` and union —
never overwrite, or the CLI will offer to prune real indexes. DEV and PROD had already drifted
(16 DEV-only, 4 PROD-only, 3 PROD-only `fieldOverrides`); this file re-converges them.

**Deploy wiring:** indexes ride along with the functions workflows (additive and idempotent).
Rules are `.github/workflows/deploy-firestore.yml`, **manual dispatch only**, with a
`dev`/`prod` input — a rules deploy is global and instant, so it never happens on merge. The
CI service accounts need `roles/datastore.indexAdmin` (indexes) and `roles/firebaserules.admin`
(rules); the index steps are `continue-on-error` until the first is granted.

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
