/**
 * The three load-bearing assumptions behind firestore.rules.
 *
 * These are not testing OUR logic — they are testing that Firestore's rules
 * engine behaves the way the rules assume it does. If any of these flip, the
 * membership rules silently stop meaning what they say, so they run first and
 * are worth keeping even though they look tautological.
 */
import {describe, it, beforeAll, afterAll, beforeEach} from "vitest";
import {doc, updateDoc, getDoc, arrayUnion, arrayRemove} from "firebase/firestore";
import {
  makeTestEnv, seed, as, assertSucceeds, assertFails,
  HOST, MEMBER, JOINER, STRANGER, FREE_EVENT, NO_CHAT_EVENT,
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

describe("assumption 1: arrayUnion/arrayRemove are visible in request.resource.data", () => {
  // onlySelfMembershipChange() and isSelfLeave() diff request.resource.data
  // against resource.data. If transforms were NOT resolved before evaluation,
  // both would see an unchanged array, every membership write would look like a
  // no-op change, and the "you may only move your own uid" guarantee would be
  // vacuous — anyone could add anyone.
  it("resolves arrayUnion of your OWN uid before evaluating (allowed)", async () => {
    const db = as(testEnv, JOINER);
    await assertSucceeds(
      updateDoc(doc(db, "eventChat", FREE_EVENT), {participants: arrayUnion(JOINER)}),
    );
  });

  it("resolves arrayUnion of SOMEONE ELSE's uid and rejects it", async () => {
    // Only passes if the engine actually saw STRANGER land in the array.
    const db = as(testEnv, JOINER);
    await assertFails(
      updateDoc(doc(db, "eventChat", FREE_EVENT), {participants: arrayUnion(STRANGER)}),
    );
  });

  it("resolves arrayRemove of someone else's uid and rejects it", async () => {
    const db = as(testEnv, MEMBER);
    await assertFails(
      updateDoc(doc(db, "eventChat", FREE_EVENT), {participants: arrayRemove(HOST)}),
    );
  });
});

describe("assumption 2: hasAny() over reference-typed participantsRef matches userPath()", () => {
  // isEventMember() compares uid()'s /user/{uid} path against the event's
  // `participantsRef`, which the Flutter client writes as DocumentReferences,
  // not strings. If path-vs-reference comparison did not work, isEventMember()
  // would be false for every free-event attendee and nobody could join a chat.
  it("lets a free-event attendee (in participantsRef, references) join the chat", async () => {
    const db = as(testEnv, JOINER);
    await assertSucceeds(
      updateDoc(doc(db, "eventChat", FREE_EVENT), {participants: arrayUnion(JOINER)}),
    );
  });

  it("denies someone absent from participantsRef", async () => {
    const db = as(testEnv, STRANGER);
    await assertFails(
      updateDoc(doc(db, "eventChat", FREE_EVENT), {participants: arrayUnion(STRANGER)}),
    );
  });
});

describe("assumption 3: get() on a missing document returns null, not an error", () => {
  // Every helper guards with `eventDoc(id) != null && eventDoc(id).data...`.
  // If a missing get() threw instead of returning null, the guard would never
  // save us and evaluation would error out — which Firestore surfaces as a
  // plain deny, so this would look like a permissions bug forever.
  it("denies (rather than errors) when the chat doc does not exist", async () => {
    const db = as(testEnv, JOINER);
    await assertFails(getDoc(doc(db, "eventChat", NO_CHAT_EVENT)));
  });

  it("still evaluates cleanly for a chat whose EVENT is missing", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc("eventChat/orphan").set({
        eventId: "orphan", hostId: HOST, participants: [MEMBER],
        mutedIds: [], bannedIds: [], isClosed: false, mode: "open",
      });
    });
    // MEMBER is a chat participant, so the first read clause matches without
    // ever consulting the (nonexistent) event.
    const db = as(testEnv, MEMBER);
    await assertSucceeds(getDoc(doc(db, "eventChat", "orphan")));
  });
});
