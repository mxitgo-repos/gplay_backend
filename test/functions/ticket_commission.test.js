/**
 * Task C — Premium "commission-free ticket sales" perk, inside
 * `createTicketPaymentIntent`.
 *
 * The claim (spend one `salesPremium` credit, lock `commissionWaived` onto the
 * event) commits in a transaction BEFORE any Stripe call. The test project's
 * functions/.env.gplay-rules-test sets STRIPE_SECRET=placeholder, so the Stripe
 * call that follows always fails and the callable returns an error — but the
 * claim is already in Firestore, which is what these tests assert. The fee
 * amount itself (0 vs the commission) is only observable in Stripe: verify it
 * on DEV in test mode.
 *
 * Callables are invoked over HTTP with an UNSIGNED JWT — see
 * redeem_benefit.test.js. Needs both emulators: `npm run test:functions`.
 */
import {describe, it, beforeAll, afterAll, beforeEach, expect} from "vitest";
import {makeTestEnv} from "../rules/helpers.js";

const PROJECT = "gplay-rules-test";
const FN_URL = `http://127.0.0.1:5001/${PROJECT}/us-central1/createTicketPaymentIntent`;

const HOST = "uid_premium_host";
const BUYER_1 = "uid_buyer_1";
const BUYER_2 = "uid_buyer_2";
const EVT_X = "evt_paid_x";
const EVT_Y = "evt_paid_y";
const EVT_Z = "evt_paid_z";
const EVT_FREE = "evt_free_c";

const DAY_MS = 24 * 60 * 60 * 1000;

let testEnv;

async function admin(fn) {
  let result;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    result = await fn(ctx.firestore());
  });
  return result;
}

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** An unsigned Firebase-shaped ID token; the emulator decodes without verifying. */
function fakeIdToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = {alg: "none", typ: "JWT"};
  const payload = {
    sub: uid, user_id: uid, uid,
    aud: PROJECT, iss: `https://securetoken.google.com/${PROJECT}`,
    iat: now, exp: now + 3600, auth_time: now,
    email: `${uid}@example.test`, email_verified: true,
    firebase: {sign_in_provider: "password", identities: {}},
  };
  return `${b64url(header)}.${b64url(payload)}.`;
}

async function buy(uid, eventId) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json", Authorization: `Bearer ${fakeIdToken(uid)}`},
    body: JSON.stringify({data: {eventId}}),
  });
  return res.json();
}

/** Overwrites the host's Premium fields (merge — accountId stays). */
const setHostPlan = (plan) => admin((db) => db.doc(`user/${HOST}`).set(plan, {merge: true}));

const credits = () => admin(async (db) => (await db.doc(`user/${HOST}`).get()).get("salesPremium"));

const waived = (eventId) => admin(async (db) => (await db.doc(`event/${eventId}`).get()).get("commissionWaived"));

beforeAll(async () => {
  testEnv = await makeTestEnv();
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await admin(async (db) => {
    await db.doc(`user/${HOST}`).set({
      verificationLevel: "id",
      accountId: ["acct_test_host"],
      isPremium: true,
      endPremium: new Date(Date.now() + 30 * DAY_MS),
      planPremium: "month",
      salesPremium: 2,
    });
    await db.doc(`user/${BUYER_1}`).set({verificationLevel: "phone"});
    await db.doc(`user/${BUYER_2}`).set({verificationLevel: "phone"});

    const paidEvent = {
      state: "Jalisco",
      interestList: "Music",
      hostRef: db.doc(`user/${HOST}`),
      isSelling: true,
      currency: "MXN",
      priceCents: 25000,
      countSelling: 100,
      currentCountSelling: 0,
      participantsRef: [],
      usersPaid: [],
    };
    await db.doc(`event/${EVT_X}`).set({...paidEvent, name: "X"});
    await db.doc(`event/${EVT_Y}`).set({...paidEvent, name: "Y"});
    await db.doc(`event/${EVT_Z}`).set({...paidEvent, name: "Z"});
    await db.doc(`event/${EVT_FREE}`).set({...paidEvent, name: "Free", isSelling: false, currency: null, priceCents: null});
  });
});

describe("Task C commission waiver", () => {
  it("the first ticket of a paid event spends one credit and locks the waiver onto the event", async () => {
    await buy(BUYER_1, EVT_X);

    expect(await credits()).toBe(1);
    expect(await waived(EVT_X)).toBe(true);
    await admin(async (db) => {
      expect((await db.doc(`event/${EVT_X}`).get()).get("commissionWaivedAt")).toBeTruthy();
    });
  }, 40000);

  it("later tickets on the same event spend nothing more", async () => {
    await buy(BUYER_1, EVT_X);
    await buy(BUYER_2, EVT_X);

    expect(await credits()).toBe(1);
  }, 40000);

  it("spends one credit per event, then charges the normal commission once they run out", async () => {
    await buy(BUYER_1, EVT_X);
    await buy(BUYER_1, EVT_Y);
    expect(await credits()).toBe(0);

    await buy(BUYER_1, EVT_Z);
    expect(await credits()).toBe(0);
    expect(await waived(EVT_Z)).toBeUndefined();
  }, 60000);

  it("keeps a claimed waiver after the plan expires", async () => {
    await buy(BUYER_1, EVT_X);
    await setHostPlan({endPremium: new Date(Date.now() - DAY_MS)});

    await buy(BUYER_2, EVT_X);
    expect(await waived(EVT_X)).toBe(true);
    expect(await credits()).toBe(1);
  }, 40000);

  it("ignores a stale isPremium whose endPremium has passed — credits untouched", async () => {
    await setHostPlan({endPremium: new Date(Date.now() - DAY_MS)});

    await buy(BUYER_1, EVT_X);
    expect(await credits()).toBe(2);
    expect(await waived(EVT_X)).toBeUndefined();
  }, 40000);

  it("treats isPremium with NO endPremium (granted by hand) as active", async () => {
    // Full overwrite (no merge) so the doc has no endPremium at all.
    await admin((db) => db.doc(`user/${HOST}`).set({
      verificationLevel: "id",
      accountId: ["acct_test_host"],
      isPremium: true,
      salesPremium: 2,
    }));

    await buy(BUYER_1, EVT_X);
    expect(await credits()).toBe(1);
    expect(await waived(EVT_X)).toBe(true);
  }, 40000);

  it("does nothing for a non-Premium host", async () => {
    await setHostPlan({isPremium: false});

    await buy(BUYER_1, EVT_X);
    expect(await credits()).toBe(2);
    expect(await waived(EVT_X)).toBeUndefined();
  }, 40000);

  it("never spends a credit on a free event (rejected before the claim)", async () => {
    const res = await buy(BUYER_1, EVT_FREE);

    expect(res.error && res.error.status).toBe("FAILED_PRECONDITION");
    expect(await credits()).toBe(2);
  }, 40000);

  it("two buyers racing on an event's first ticket spend exactly one credit", async () => {
    await Promise.all([buy(BUYER_1, EVT_X), buy(BUYER_2, EVT_X)]);

    expect(await credits()).toBe(1);
    expect(await waived(EVT_X)).toBe(true);
  }, 40000);
});
