# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **STARTER** — drafted from the GPlay mobile app's perspective; it knows the
> interface this backend must satisfy but not this repo's exact layout. Verify
> the `TODO` items (or re-run `/init`) and delete this banner once confirmed.

## Project Overview

Firebase **Cloud Functions** (TypeScript) backend for **GPlay**, a Flutter
social-events app. Responsibilities: Stripe payments & Connect payouts (host
ticket sales), Firestore-derived access enforcement, referral/MLM processing,
IAP receipt validation, and notifications. Two Firebase projects mirror the app:
**G-Play-dev (`g-play-dev-e4c4c`)** = production, **G-Play (`g-play-dd31d`)** = dev.

## Common Commands

```bash
# TODO: confirm against package.json
npm install                         # in the functions/ dir
npm run build                       # tsc → lib/
npm run lint
firebase emulators:start --only functions,firestore   # local
firebase deploy --only functions                       # deploy all
firebase deploy --only functions:createTicketPaymentIntent   # deploy one
firebase functions:config:get       # view runtime config (if used)
```

Switch project before deploy: `firebase use dev` / `firebase use prod`
(TODO: confirm alias names in `.firebaserc`).

## Architecture

- **Entry point:** `src/index.ts` exports all functions (TODO: confirm path;
  some projects split into `src/stripe/`, `src/referrals/`, etc.).
- **Callables** (`functions.https.onCall`) — invoked from the app via
  `httpsCallable('<name>')`; auth is in `context.auth`.
- **HTTP** (`functions.https.onRequest`) — e.g. Stripe webhooks, `checkEmail`,
  `appleCallbackHandler`.
- **Firestore triggers** (`onWrite`/`onCreate`) — derived data & fan-out.
- **Admin SDK** for Firestore/Auth; **Stripe SDK** for payments. Secrets via
  environment config / Secret Manager (TODO: confirm which; never hardcode).

### Existing functions (referenced by the app — confirm names/signatures)
Stripe Connect / payouts: `createCustomAccount`, `updateCustomAccount`,
`addBankAccount`, `getBankAccount`, `createPayout`, `createPayoutDestination`,
`createTransfer`, `createPaymentIntent`, `acceptTos`, `uploadDocument`.
Other: `getUserData`, `processReferral`, `validateAppleReceipt`,
`validateGooglePurchase`, `checkEmail` (HTTP), `appleCallbackHandler` (HTTP).

> Reuse the existing **Connect onboarding** (host connected accounts) — do NOT
> rebuild it — when implementing ticket payments.

## Conventions

- TypeScript; build with `tsc`. Match the existing files' style (TODO: confirm
  region, e.g. `us-central1`, and Node runtime in `package.json` engines).
- Callables throw `functions.https.HttpsError(code, message)` with a
  user-facing `message` — the app surfaces it directly to users.
- Money: amounts in **minor units** (cents). Stripe Connect uses **destination
  charges** + `application_fee_amount` for GPlay's commission.
- Webhooks must be **idempotent** (Stripe retries) and verify the signature.
- Firestore writes that fulfill purchases must guard against double-application.

## The client contract (source of truth)

`docs/backend-implementation-brief.md` (copied from the Flutter repo) defines the
exact callables, request/response JSON, Firestore shapes, the §1/§2/§3 access
matrix, and acceptance criteria the mobile app depends on. **Implement to that
brief; do not change the shapes the client already calls.** Pending work:
- Stripe ticket payments: `createTicketPaymentIntent`, `payment_intent.succeeded`
  webhook fulfillment, `confirmTicketPurchase`.
- Access enforcement: `events_public` projection trigger, `getEventForViewer`
  callable, locked Firestore security rules.

## Secrets / config (confirm, never commit)

- Stripe secret key + webhook signing secret.
- (TODO) any others the existing functions use.
