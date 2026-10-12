/**
 * B5 — `redeemEventBenefit` callable.
 *
 * Note this function is currently DORMANT: nothing calls it. The Flutter client
 * still runs its own Firestore transaction (which the rules still permit), so
 * these tests protect a code path that is not yet live. Worth having anyway —
 * the moment the client switches over, this is the money path.
 *
 * Callables are invoked over HTTP with an UNSIGNED JWT: the functions emulator
 * decodes `Authorization: Bearer` without verifying the signature, which is the
 * only way to exercise `context.auth` without also running the auth emulator.
 *
 * Needs both emulators: `npm run test:functions`.
 */
import {describe, it, beforeAll, afterAll, beforeEach, expect} from "vitest";
import {makeTestEnv} from "../rules/helpers.js";

const PROJECT = "gplay-rules-test";
const FN_URL = `http://127.0.0.1:5001/${PROJECT}/us-central1/redeemEventBenefit`;

const HOST = "uid_host";
const BUYER = "uid_buyer";
const BROKE = "uid_broke";
const OUTSIDER = "uid_outsider";
const UNVERIFIED = "uid_unverified";
const EVENT_ID = "evt_benefit";

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

async function callRedeem(uid, data) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(uid ? {Authorization: `Bearer ${fakeIdToken(uid)}`} : {}),
    },
    body: JSON.stringify({data}),
  });
  const json = await res.json();
  return json.result ?? json;
}

beforeAll(async () => {
  testEnv = await makeTestEnv();
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await admin(async (db) => {
    await db.doc(`user/${HOST}`).set({verificationLevel: "id", gTokens: 50});
    await db.doc(`user/${BUYER}`).set({verificationLevel: "phone", gTokens: 5});
    await db.doc(`user/${BROKE}`).set({verificationLevel: "phone", gTokens: 0});
    await db.doc(`user/${OUTSIDER}`).set({verificationLevel: "phone", gTokens: 5});
    await db.doc(`user/${UNVERIFIED}`).set({verificationLevel: "none", gTokens: 5});

    await db.doc(`event/${EVENT_ID}`).set({
      name: "Benefit event",
      state: "Jalisco",
      interestList: "Music",
      hostRef: db.doc(`user/${HOST}`),
      isSelling: false,
      participantsRef: [db.doc(`user/${BUYER}`), db.doc(`user/${BROKE}`), db.doc(`user/${UNVERIFIED}`)],
      usersPaid: [],
      benefitPhoto: "https://example.test/b.jpg",
      benefitDescription: "2x1 en margaritas",
    });
  });
});

describe("B5 redeemEventBenefit", () => {
  // NOTE the response shape is asymmetric: on success the code lives at
  // `result.redemption.code`, but on alreadyRedeemed it is flat at
  // `result.code`. Pinned here because a client handling both paths has to know
  // that, and it is the kind of thing that gets "tidied" into a bug.
  it("redeems: deducts exactly 1 G-Shard and issues a BEN- code", async () => {
    const result = await callRedeem(BUYER, {eventId: EVENT_ID});

    expect(result.success).toBe(true);
    expect(result.redemption.code)
      .toMatch(/^BEN-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    expect(result.redemption.status).toBe("active");
    expect(result.redemption.costGShards).toBe(1);
    // Millis rather than a Timestamp — callable responses are JSON.
    expect(typeof result.redemption.redeemedAt).toBe("number");

    await admin(async (db) => {
      expect((await db.doc(`user/${BUYER}`).get()).get("gTokens")).toBe(4);

      const redemption = await db.doc(`event/${EVENT_ID}/benefitRedemptions/${BUYER}`).get();
      expect(redemption.exists).toBe(true);
      expect(redemption.get("status")).toBe("active");
      expect(redemption.get("code")).toBe(result.redemption.code);
      // Snapshotted from the EVENT, so a later host edit can't change what
      // somebody already paid for.
      expect(redemption.get("benefitDescription")).toBe("2x1 en margaritas");
    });
  }, 40000);

  it("writes the gTokens receipt onto the user doc", async () => {
    await callRedeem(BUYER, {eventId: EVENT_ID});

    await admin(async (db) => {
      const receipts = (await db.doc(`user/${BUYER}`).get()).get("transactions") || [];
      const benefit = receipts.find((t) => t.reason === "eventBenefit");
      expect(benefit).toBeTruthy();
      expect(benefit.price).toBe(1);
      expect(benefit.type).toBe("gtokens");
      expect(benefit.eventId).toBe(EVENT_ID);
    });
  }, 40000);

  it("is single-use — a second call returns alreadyRedeemed without charging again", async () => {
    const first = await callRedeem(BUYER, {eventId: EVENT_ID});
    const second = await callRedeem(BUYER, {eventId: EVENT_ID});

    expect(second.success).toBe(false);
    expect(second.reason).toBe("alreadyRedeemed");
    expect(second.code).toBe(first.redemption.code);

    await admin(async (db) => {
      // Charged once, not twice.
      expect((await db.doc(`user/${BUYER}`).get()).get("gTokens")).toBe(4);
    });
  }, 40000);

  it("refuses an empty balance and does not issue a code", async () => {
    const result = await callRedeem(BROKE, {eventId: EVENT_ID});

    expect(result.success).toBe(false);
    expect(result.reason).toBe("insufficientFunds");

    await admin(async (db) => {
      expect((await db.doc(`event/${EVENT_ID}/benefitRedemptions/${BROKE}`).get()).exists).toBe(false);
      expect((await db.doc(`user/${BROKE}`).get()).get("gTokens")).toBe(0);
    });
  }, 40000);

  it("refuses a non-attendee", async () => {
    const result = await callRedeem(OUTSIDER, {eventId: EVENT_ID});
    expect(result.success).toBe(false);
    expect(result.reason).toBe("permissionDenied");
  }, 40000);

  it("refuses an unverified (registered-only) attendee", async () => {
    const result = await callRedeem(UNVERIFIED, {eventId: EVENT_ID});
    expect(result.success).toBe(false);
    expect(result.reason).toBe("permissionDenied");
  }, 40000);

  it("refuses an unauthenticated caller", async () => {
    const result = await callRedeem(null, {eventId: EVENT_ID});
    expect(result.success).toBe(false);
    expect(result.reason).toBe("unauthenticated");
  }, 40000);

  it("refuses an event with no benefit configured", async () => {
    await admin((db) => db.doc(`event/${EVENT_ID}`).set({benefitPhoto: null, benefitDescription: null}, {merge: true}));
    const result = await callRedeem(BUYER, {eventId: EVENT_ID});
    expect(result.success).toBe(false);
    expect(result.reason).toBe("noBenefit");
  }, 40000);

  it("refuses a missing event and a missing eventId", async () => {
    expect((await callRedeem(BUYER, {eventId: "does_not_exist"})).reason).toBe("notFound");
    expect((await callRedeem(BUYER, {})).reason).toBe("invalidArgument");
  }, 40000);
});
