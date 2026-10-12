/**
 * §7 benefit redemptions, plus the two things most likely to be broken by an
 * edit elsewhere in the file:
 *   - the permissive baseline still working for the ~48 legacy collections
 *   - rule PRECEDENCE, i.e. no baseline match re-opening the tight sections
 *
 * Firestore grants on ANY matching rule, so a stray `match /{document=**}` (or a
 * convenience `match /event/{id}/{sub=**}`) would silently undo every tight rule
 * without failing any of the allow-tests. The precedence block is the guard.
 */
import {describe, it, beforeAll, afterAll, beforeEach} from "vitest";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, addDoc, serverTimestamp,
} from "firebase/firestore";
import {
  makeTestEnv, seed, as, asGuest, asAnon, assertSucceeds, assertFails,
  HOST, MEMBER, JOINER, STRANGER, FREE_EVENT,
} from "./helpers.js";

let testEnv;

beforeAll(async () => {
  testEnv = await makeTestEnv();
});

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed(testEnv);
});

const redemption = (uid) => ({
  userId: uid, eventId: FREE_EVENT, code: "BEN-11111-22222",
  redeemedAt: serverTimestamp(), costGShards: 1, status: "active",
  benefitDescription: "2x1 en margaritas", benefitPhoto: "https://example.test/b.jpg",
});

describe("§7 benefit redemptions", () => {
  it("lets the holder mint their own redemption", async () => {
    await assertSucceeds(
      setDoc(doc(as(testEnv, JOINER), "event", FREE_EVENT, "benefitRedemptions", JOINER), redemption(JOINER)),
    );
  });

  it("denies minting a redemption for somebody else", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, JOINER), "event", FREE_EVENT, "benefitRedemptions", STRANGER), redemption(STRANGER)),
    );
  });

  it("denies minting one already marked used", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, JOINER), "event", FREE_EVENT, "benefitRedemptions", JOINER),
        {...redemption(JOINER), status: "used"}),
    );
  });

  it("denies a userId that disagrees with the doc id", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, JOINER), "event", FREE_EVENT, "benefitRedemptions", JOINER),
        {...redemption(JOINER), userId: STRANGER}),
    );
  });

  it("lets the holder read their own, and the host read it", async () => {
    const path = ["event", FREE_EVENT, "benefitRedemptions", MEMBER];
    await assertSucceeds(getDoc(doc(as(testEnv, MEMBER), ...path)));
    await assertSucceeds(getDoc(doc(as(testEnv, HOST), ...path)));
  });

  it("denies a third party reading someone else's redemption", async () => {
    await assertFails(getDoc(doc(as(testEnv, JOINER), "event", FREE_EVENT, "benefitRedemptions", MEMBER)));
  });

  it("lets the host burn a code at the door", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, HOST), "event", FREE_EVENT, "benefitRedemptions", MEMBER),
        {status: "used", usedAt: serverTimestamp(), usedBy: HOST}),
    );
  });

  it("denies the holder burning their own code", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "event", FREE_EVENT, "benefitRedemptions", MEMBER),
        {status: "used", usedAt: serverTimestamp(), usedBy: MEMBER}),
    );
  });

  it("denies the host rewriting the code while burning it", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, HOST), "event", FREE_EVENT, "benefitRedemptions", MEMBER),
        {status: "used", usedAt: serverTimestamp(), usedBy: HOST, code: "BEN-99999-99999"}),
    );
  });

  it("denies un-burning a code (one-way only)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore()
        .doc(`event/${FREE_EVENT}/benefitRedemptions/${MEMBER}`)
        .set({status: "used"}, {merge: true});
    });
    await assertFails(
      updateDoc(doc(as(testEnv, HOST), "event", FREE_EVENT, "benefitRedemptions", MEMBER),
        {status: "active"}),
    );
  });
});

describe("baseline non-regression (the ~48 legacy collections)", () => {
  // The app has no client-side ownership model; these writes are what the live
  // client does today. If any of them start failing, the tight rules have
  // over-reached and the app breaks in production.
  it("lets a signed-in user read and write their own user doc", async () => {
    const db = as(testEnv, MEMBER);
    await assertSucceeds(getDoc(doc(db, "user", MEMBER)));
    await assertSucceeds(updateDoc(doc(db, "user", MEMBER), {name: "renamed"}));
  });

  it("lets a signed-in user read ANOTHER user's doc (profiles, attendee lists)", async () => {
    await assertSucceeds(getDoc(doc(as(testEnv, MEMBER), "user", HOST)));
  });

  it("lets a signed-in user write the global counter singletons", async () => {
    const db = as(testEnv, MEMBER);
    await assertSucceeds(setDoc(doc(db, "coins", "UUFdzV2ubYg28628CEBH"), {dailyCoins: 1}, {merge: true}));
    await assertSucceeds(setDoc(doc(db, "eventsDetails", "rWJ7dYgyWgRsFPfqrC6T"), {assistants: 1}, {merge: true}));
  });

  it("lets a signed-in user read events and write event subcollections", async () => {
    const db = as(testEnv, MEMBER);
    await assertSucceeds(getDoc(doc(db, "event", FREE_EVENT)));
    await assertSucceeds(addDoc(collection(db, "event", FREE_EVENT, "question"), {content: "q"}));
    await assertSucceeds(addDoc(collection(db, "event", FREE_EVENT, "comment"), {content: "c"}));
    await assertSucceeds(addDoc(collection(db, "event", FREE_EVENT, "participants"), {userId: MEMBER}));
  });

  it("lets a signed-in user use the 1:1 chat collections", async () => {
    const db = as(testEnv, MEMBER);
    const chatId = [MEMBER, HOST].sort().join("_");
    await assertSucceeds(setDoc(doc(db, "message", chatId), {participants: [MEMBER, HOST]}));
    await assertSucceeds(addDoc(collection(db, "message", chatId, "messages"), {content: "hi"}));
    await assertSucceeds(setDoc(doc(db, "request", chatId), {participants: [MEMBER, HOST]}));
  });

  it("allows an ANONYMOUS guest (guest mode is Firebase anonymous auth)", async () => {
    await assertSucceeds(getDoc(doc(asAnon(testEnv), "event", FREE_EVENT)));
  });

  it("denies a fully signed-out client", async () => {
    const db = asGuest(testEnv);
    await assertFails(getDoc(doc(db, "event", FREE_EVENT)));
    await assertFails(getDoc(doc(db, "user", MEMBER)));
    await assertFails(setDoc(doc(db, "coins", "UUFdzV2ubYg28628CEBH"), {dailyCoins: 1}));
  });
});

describe("events_public (guest-safe mirror, trigger-written only)", () => {
  beforeEach(async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`events_public/${FREE_EVENT}`).set({name: "Free event", attendeeCount: 5});
    });
  });

  it("is readable by anyone, signed out included", async () => {
    await assertSucceeds(getDoc(doc(asGuest(testEnv), "events_public", FREE_EVENT)));
    await assertSucceeds(getDoc(doc(asAnon(testEnv), "events_public", FREE_EVENT)));
    await assertSucceeds(getDoc(doc(as(testEnv, MEMBER), "events_public", FREE_EVENT)));
  });

  it("is writable by no client, not even the event's host", async () => {
    await assertFails(updateDoc(doc(as(testEnv, HOST), "events_public", FREE_EVENT), {attendeeCount: 999}));
    await assertFails(setDoc(doc(as(testEnv, MEMBER), "events_public", "forged"), {name: "x"}));
    await assertFails(deleteDoc(doc(as(testEnv, HOST), "events_public", FREE_EVENT)));
  });
});

describe("event docs: Task C commission fields are server-only", () => {
  it("still lets a signed-in user create, edit and delete events", async () => {
    const db = as(testEnv, HOST);
    const created = await assertSucceeds(addDoc(collection(db, "event"), {name: "New", isSelling: false}));
    await assertSucceeds(updateDoc(doc(db, "event", FREE_EVENT), {name: "Renamed", bio: "b"}));
    await assertSucceeds(deleteDoc(created));
  });

  it("denies creating an event that is already commission-waived", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, HOST), "event"), {name: "New", isSelling: true, commissionWaived: true}),
    );
  });

  it("denies a client setting or clearing commissionWaived / commissionWaivedAt", async () => {
    const db = as(testEnv, HOST);
    await assertFails(updateDoc(doc(db, "event", FREE_EVENT), {commissionWaived: true}));
    await assertFails(updateDoc(doc(db, "event", FREE_EVENT), {commissionWaivedAt: serverTimestamp()}));

    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`event/${FREE_EVENT}`).set({commissionWaived: true}, {merge: true});
    });
    await assertFails(updateDoc(doc(db, "event", FREE_EVENT), {commissionWaived: false}));
  });

  it("allows ordinary edits to an event that is already waived", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`event/${FREE_EVENT}`).set({commissionWaived: true}, {merge: true});
    });
    await assertSucceeds(updateDoc(doc(as(testEnv, HOST), "event", FREE_EVENT), {name: "Renamed"}));
  });
});

describe("precedence: no baseline match may re-open the tight sections", () => {
  // These are the exact holes a future `match /{document=**}` or
  // `match /event/{id}/{sub=**}` would punch. They pass only because the
  // baseline is expressed at fixed depths with the protected roots excluded
  // by name — see the header of firestore.rules before touching it.
  it("a stranger still cannot reach eventChat via the depth-2 baseline", async () => {
    await assertFails(getDoc(doc(as(testEnv, STRANGER), "eventChat", FREE_EVENT)));
    await assertFails(setDoc(doc(as(testEnv, STRANGER), "eventChat", "brand_new"), {participants: [STRANGER]}));
  });

  it("a stranger still cannot reach chat messages via the depth-4 baseline", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, STRANGER), "eventChat", FREE_EVENT, "messages"), {content: "x"}),
    );
  });

  it("a third party still cannot reach benefitRedemptions via the depth-4 baseline", async () => {
    await assertFails(
      getDoc(doc(as(testEnv, STRANGER), "event", FREE_EVENT, "benefitRedemptions", MEMBER)),
    );
    await assertFails(
      deleteDoc(doc(as(testEnv, STRANGER), "event", FREE_EVENT, "benefitRedemptions", MEMBER)),
    );
  });

  it("sibling event subcollections are NOT caught by the benefitRedemptions carve-out", async () => {
    // Guards against over-correcting the exclusion into `collection == "event"`.
    await assertSucceeds(
      addDoc(collection(as(testEnv, MEMBER), "event", FREE_EVENT, "answer"), {content: "a"}),
    );
  });
});
