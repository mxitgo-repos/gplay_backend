# GPlay Backend — Implementation Brief (for Claude Code in the Cloud Functions repo)

> **How to use this:** Commit this file into the GPlay Cloud Functions repo and
> open a Claude Code session there. Paste the "Kickoff prompt" below as your
> first message. This brief is self-contained — it carries the full contract
> from the Flutter app, so you do NOT need access to the Flutter repo.

---

## Kickoff prompt (paste into the functions-repo session)

> You are working in the GPlay Cloud Functions repo (**plain JavaScript**, a
> single `functions/index.js`, **v1** `firebase-functions` API + Admin SDK —
> read `CLAUDE.md`). Read the existing Stripe functions already in `index.js`
> (`createCustomAccount`, `updateCustomAccount`, `addCard`, `acceptTos`,
> `uploadDocument`, `createTransfer`, `createPaymentIntent`, …) and match their
> style: `exports.fnName = functions.https.onCall(async (data, context) => {…})`,
> throwing `new functions.https.HttpsError(code, message)`. Stripe is already
> wired (`const stripe = new Stripe(process.env.STRIPE_SECRET)`). Then implement
> the task groups in this file: **(A) Stripe ticket payments**, **(B)
> server-side access enforcement** and **(C) the Premium commission-free ticket
> sales perk**, adding new exports to `index.js` (C changes A1 and the B3 rules). Match the
> exact request/response shapes specified — the Flutter client is already written
> against them and must not change. Reuse existing Connect onboarding rather than
> re-building it. Propose a plan before coding.

## Codebase reality (confirmed 2026-06-18)
- **Language:** plain JavaScript, **not** TypeScript. No build step, no `src/`/`lib/`.
- **Layout:** every function is an `exports.*` in `functions/index.js` (~3900 lines,
  ~51 exports), v1 API (`functions.https.onCall` / `.onRequest`,
  `functions.firestore.document(...)`, `functions.pubsub.schedule(...)`).
- **Stripe:** `stripe@^17` already a dependency; `process.env.STRIPE_SECRET`.
- **Deploy:** from `functions/` → `npm run lint` then `firebase deploy --only functions`
  (or `:functionName`). Node 20, region default `us-central1`. One project:
  `g-play-dev-e4c4c`.
- Ignore any "TypeScript / `src/index.ts`" phrasing elsewhere in this brief — the
  *contract* (names, payloads, Firestore shapes, the §1 matrix, acceptance
  criteria) is what matters; implement it in JS/v1.

---

## Background

The GPlay Flutter app implements, client-side:
- **Stripe Phase 1** real-money tickets (§6): events now carry `currency`
  ('MXN'/'USD') + `priceCents`; paying for a ticket calls the backend and
  presents a Stripe PaymentSheet.
- **Guest mode + access levels** (§1/§2/§3): guests/registered/verified see
  progressively more event info.

The client cannot enforce data hiding or move money on its own — that's this
repo's job. Three task groups below.

### Locked decisions (do not re-litigate)
- **Q3:** Data hiding is **server-side enforced** (a technical user reading
  Firestore must not see hidden fields).
- **Q4:** Stripe **Connect destination charges** + `application_fee_amount`
  (host gets paid directly; G-Play commission auto-deducted).
- **Q5:** Legacy events priced in G-Tokens (selling, but **no `currency` field**)
  are **hidden** until re-priced — exclude them everywhere.

### Event document shape the client writes (collection `event`)
Relevant fields: `isSelling: bool`, `currency: 'MXN'|'USD'|null`,
`priceCents: int|null` (minor units), `price: int` (legacy major-units, display
only), `countSelling: int`, `currentCountSelling: int`, `usersPaid: string[]`,
`participantsRef: DocumentReference[]`, `peopleCapacity: int`, `hostRef`,
`startDate`/`endDate: Timestamp`, `location: {geopoint, geohash}`,
`locationName`, `name`, `photo`, `mood` (vibe/category), `bio` (description).
A **paid fiat event** = `isSelling == true && currency != null`. A **free
event** = `isSelling != true`. A **legacy G-Token paid event** =
`isSelling == true && currency == null` (HIDE per Q5).

---

## TASK A — Stripe ticket payments (§6, Phase 1)

### A1. `createTicketPaymentIntent({ eventId })` — HTTPS callable
- **Auth:** required; caller must be **verified** (user doc `kyc == true`).
  Reject unauthenticated, anonymous, and unverified callers.
- **Validate** (read the event server-side): reject if `!isSelling`, if
  `currency == null` (legacy/free), if sold out
  (`currentCountSelling >= countSelling`), or if `auth.uid` is already in
  `usersPaid`.
- **Amount is computed server-side** from `priceCents` + `currency` — never
  trust a client-sent amount (the client sends none).
- **Charge:** create a Stripe **PaymentIntent as a Connect destination charge**
  to the host's connected account (resolve from the host user / existing Connect
  onboarding), with `application_fee_amount` = G-Play's commission. Put
  `{ eventId, uid }` in PaymentIntent `metadata`. Use an **idempotency key** of
  `\`${eventId}:${uid}\`` to prevent double-charge.
- **Return JSON** (the client maps this exactly):
  ```json
  {
    "clientSecret": "pi_..._secret_...",
    "paymentIntentId": "pi_...",
    "amount": 5000,
    "currency": "MXN",
    "customerId": "cus_...",            // optional
    "ephemeralKeySecret": "ek_..."      // optional (only if attaching a Customer)
  }
  ```
- **Errors:** throw `HttpsError` with a user-facing `message` (the client shows
  `e.message`).

### A2. `payment_intent.succeeded` webhook — SOURCE OF TRUTH for fulfillment
- Verify the Stripe signature. On success, using `metadata.eventId` +
  `metadata.uid`, perform the join writes (mirror a free join, **no G-Token
  deduction**): `event.participantsRef` arrayUnion the buyer ref,
  `event.usersPaid` arrayUnion the uid, `event.currentCountSelling` increment by
  1, and add the event to the user's `attendedEventsRef`.
- **Must be idempotent** (Stripe retries webhooks): guard on uid already in
  `usersPaid`.
- (Phase 6, when event chat exists) also add the buyer to the event chat
  participants.

### A3. `confirmTicketPurchase({ eventId, paymentIntentId })` — HTTPS callable
- UX trigger / fallback the client calls right after the PaymentSheet succeeds.
  Verify the PaymentIntent is `succeeded`; if the webhook hasn't fulfilled yet,
  perform the **same idempotent fulfillment** as A2. Safe to call after the
  webhook already ran (no double-add). The client swallows errors here, so it
  must never corrupt state.

### A acceptance criteria
- Verified user buys an MXN event with test card `4242…` → becomes a
  participant, `usersPaid` updated, `currentCountSelling` +1, **no gTokens
  touched**; host's connected account receives funds minus the application fee.
- Declined card → no participant change, clean error.
- Calling twice / webhook + confirm both firing → exactly one join (idempotent).
- Legacy G-Token event or unverified caller → rejected.

---

## TASK B — Server-side access enforcement (§1/§2/§3, Q3)

### Access levels
| Level | Definition |
|-------|------------|
| **guest** | unauthenticated OR anonymous (`auth.token.firebase.sign_in_provider == 'anonymous'`) |
| **registered** | signed-in, user doc `kyc == false` |
| **verified** | signed-in, `kyc == true` |

N3 *full* access also requires having joined (free: in `participantsRef`) or
paid (paid: in `usersPaid`).

### Field visibility matrix (transcribe exactly; `paid` = `isSelling && currency != null`)
Attendee **count** is ALWAYS visible at every level. Exact time and full
description are hidden from **guests on all event types** (customer direction).

| Field | guest | registered | verified + joined/paid |
|-------|:----:|:----------:|:----------------------:|
| name, category/vibe, attendee **count**, general date | ✓ | ✓ | ✓ |
| image url | ✓ (client blurs) | ✓ | ✓ |
| price range (paid only) | ✓ | (exact) | (exact) |
| exact price (paid) | ✗ | ✓ | ✓ |
| exact time | ✗ | ✓ | ✓ |
| full description | ✗ | ✓ | ✓ |
| partial attendee list | ✗ | ✓ | (full) |
| **exact address / geopoint** | ✗ | ✗ | ✓ |
| **benefits** | ✗ | ✗ | ✓ |
| **event chat** | ✗ | ✗ | ✓ |
| **full attendee list** | ✗ | ✗ | ✓ |

### B1. `events_public/{eventId}` projection — Firestore `onWrite` trigger on `event/{eventId}`
- Maintain a safe, read-by-anyone mirror containing ONLY: `name`, `photo`,
  `mood`/category, vibe, `attendeeCount` (a number = `participantsRef.length`),
  general date (e.g. `startDate` rounded to the day — never exact time for paid
  events), and for paid events a `priceBracket`
  (`under200Mxn|between200And500Mxn|over500Mxn|exactUsd` + USD amount).
- **Exclude** always: exact address/`location.geopoint`, `usersPaid`, full
  `participantsRef`, benefit fields, chat refs.
- **Exclude the whole doc** for legacy G-Token paid events (`isSelling && !currency`, Q5)
  and for closed/private/ended events (match the client's list filters).

### B2. `getEventForViewer({ eventId })` — HTTPS callable (the N2/registered read path)
- Compute the caller's level (guest/registered/verified + joined/paid) and return
  the **level-appropriate projection** per the matrix above. This is the single
  source of truth that mirrors the client's `access_control` table. (Firestore
  rules can't field-filter, so the registered tier reads through this callable.)

### B3. Firestore security rules
- `event/{eventId}`: full doc readable only by **verified** users who are in
  `participantsRef` (free) or `usersPaid` (paid). Everyone else is denied the
  full doc and reads `events_public` / `getEventForViewer` instead.
- `events_public/{eventId}`: `allow read: if true;` `allow write: if false;`
  (trigger-maintained).
- Keep `request.auth != null` working for anonymous (guest) users — anonymous
  auth IS authenticated.

### B acceptance criteria
- Guest/anonymous reading `event/{id}` directly → **denied**; reading
  `events_public/{id}` → only the safe fields; no exact address/time/usersPaid.
- Registered (kyc=false) via `getEventForViewer` → sees name/time/description/
  partial list but NOT address/benefits/chat/full list.
- Verified + joined/paid → full doc.
- Legacy G-Token paid event → absent from `events_public`.

---

## TASK C — Premium "commission-free ticket sales" perk (QA round 2026-10)

### Problem
Every Premium plan advertises **"Venta de boletos sin comisión (hasta 2
eventos)"** — the host's first **2 paid events** carry no G-Play commission.
For real-money (fiat) tickets that commission is the Stripe
`application_fee_amount` set in **A1**, and A1 knows nothing about Premium, so
Premium hosts pay the full commission on every MXN/USD ticket. The app can't fix
this: the fee is decided server-side at payment time. (A customer QA report on
2026-10-12: "tener 2 eventos con costo sin comisión… todas me las está
cobrando".)

### What the client already does (don't duplicate)
- The **purchase** (client, `putBuyTokensPremium`) writes to the host's user doc:
  `isPremium: true`, `endPremium: Timestamp` (week = +7 days, `month` = **+6
  months**, year = +1 year), `planPremium: 'week'|'month'|'year'`, and
  `salesPremium: 2` (set, not incremented — a re-purchase resets it to 2).
- **Expiry** (client, since 2026-10): on launch the app flips `isPremium` to
  `false` once `endPremium` has passed. Don't rely on that alone: a host who
  doesn't open the app stays `isPremium: true` past expiry. A user with
  `isPremium: true` and **no** `endPremium` was granted by hand and does not
  expire.
- The client spends `salesPremium` **only** for legacy G-Token paid events, at
  event finish (`eventFinish` `feeOption`). Those are hidden per Q5, so in
  practice the client never spends a credit on a fiat event. **Fiat events are
  entirely this task's job**, so there's no double spend.

### Rule
A host has **active Premium** when
`isPremium == true && (endPremium == null || endPremium > now)`. Use server
time; never trust a client-sent flag.

A credit is spent **per event, not per ticket**: the first time a paid fiat
event of an active-Premium host with `salesPremium > 0` sells a ticket, the
event becomes commission-free and the host loses one credit. All later tickets
of that event are also commission-free, and no further credit is spent on it.

### C1. Changes to `createTicketPaymentIntent` (A1)
Inside a Firestore **transaction** on `event/{eventId}` + the host's
`user/{hostUid}`:
1. If `event.commissionWaived == true`, use `application_fee_amount = 0`.
2. Else, if the host has active Premium and `salesPremium > 0`: set
   `event.commissionWaived = true`, `event.commissionWaivedAt = serverTimestamp`,
   decrement `user.salesPremium` by 1, and use `application_fee_amount = 0`.
3. Else charge the normal commission.

Doing this in the transaction makes two buyers racing on the event's first
ticket spend exactly one credit. Put `commissionWaived: 'true'|'false'` in the
PaymentIntent `metadata` for auditing.

**Accepted trade-off:** the credit is spent when the first PaymentIntent is
created, even if that payment then fails. The event stays waived, so the credit
isn't lost; it simply belongs to that event. The alternative, claiming in the
A2 webhook, is too late: `application_fee_amount` is fixed when the intent is
created.

### C2. Fields
- `event.commissionWaived: bool` (absent = false), `event.commissionWaivedAt:
  Timestamp`. Server-written only: add both to the client-unwritable fields in
  the Firestore rules (B3).
- `user.salesPremium: int` remains the counter (the app's My Plan screen shows
  `salesPremium/2`).

### Open product questions (confirm with the customer; defaults in bold)
- If the plan expires while a waived event is still selling, do later tickets
  stay commission-free? **Yes: the waiver is locked to the event once claimed.**
- Should a free event, or a paid event that never sells, consume a credit?
  **No: only the first ticket sale claims it** (this matches C1).

### C acceptance criteria
- An active-Premium host with `salesPremium: 2` sells tickets on paid event X.
  The first PaymentIntent has `application_fee_amount = 0`, X gets
  `commissionWaived: true`, and `salesPremium` drops to 1. A second ticket on X
  also has fee 0, and `salesPremium` stays 1.
- A second paid event Y does the same, and `salesPremium` drops to 0. A third
  paid event Z is charged the normal commission.
- A host with `isPremium: true` but `endPremium` in the past is charged the
  normal commission, and their credits are untouched.
- Two buyers creating the first PaymentIntents of an event concurrently spend
  exactly one credit.
- Free events and non-Premium hosts behave exactly as A1.

---

## Notes
- Apple/IAP untouched: real-world event tickets are a service → Stripe allowed;
  G-Shards (gTokens) stay rewards-only.
- If the client interface ever needs to change, update both this brief and the
  Flutter `lib/repositories/payments_repository.dart` together — those shapes
  are the frozen contract.
- This brief is the portable copy of the Flutter repo's
  `docs/backend_access_control_contract.md`; keep them consistent.
