/**
 * B4 — `cleanupDeletedEvent` cascade.
 *
 * Driven through the emulator by writing documents and observing effects,
 * rather than by importing the handler: there is no `firebase-functions-test`
 * here (removed over a firebase-admin v13 peer conflict), and an end-to-end
 * trigger run proves the trigger REGISTRATION too, which importing wouldn't.
 *
 * Reads/writes go through `withSecurityRulesDisabled` rather than
 * firebase-admin — same rule-bypassing access, and firebase-admin only exists
 * under functions/node_modules, so using it here would mean duplicating a large
 * dependency at the root purely for tests.
 *
 * Needs BOTH emulators: `npm run test:functions`.
 */
import {describe, it, beforeAll, afterAll, expect} from "vitest";
import {makeTestEnv} from "../rules/helpers.js";

const EVENT_ID = "evt_cascade";
const SUBCOLLECTIONS = ["question", "comment", "answer", "participants", "benefitRedemptions"];

let testEnv;

/** Polls until `check` passes or the budget runs out — triggers are async. */
async function eventually(check, {timeoutMs = 25000, intervalMs = 500} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw lastError;
}

/**
 * Runs `fn` with a rules-bypassing Firestore handle.
 *
 * withSecurityRulesDisabled() resolves to void — it does NOT forward the
 * callback's return value — so capture it rather than returning through.
 */
async function admin(fn) {
  let result;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    result = await fn(ctx.firestore());
  });
  return result;
}

beforeAll(async () => {
  testEnv = await makeTestEnv();
  await testEnv.clearFirestore();
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("B4 cleanupDeletedEvent", () => {
  it("sweeps the chat, its messages, pushState, and every subcollection", async () => {
    await admin(async (db) => {
      const eventRef = db.doc(`event/${EVENT_ID}`);
      const chatRef = db.doc(`eventChat/${EVENT_ID}`);

      // `state` and `interestList` are only here to keep the UNRELATED onCreate
      // triggers quiet: sendNotificationByState (index.js:667) does
      // `eventData.state.toLowerCase()` with no guard and crashes on an event
      // doc without it. Pre-existing, not a §5/§7 concern — reported separately.
      await eventRef.set({
        name: "Cascade me",
        hostRef: db.doc("user/uid_host"),
        state: "Jalisco",
        interestList: "Music",
      });
      await chatRef.set({eventId: EVENT_ID, hostId: "uid_host", participants: ["uid_host"]});
      await chatRef.collection("messages").doc("m1").set({senderId: "uid_host", content: "hi"});
      await chatRef.collection("messages").doc("m2").set({senderId: "uid_host", content: "there"});
      await chatRef.collection("pushState").doc("state").set({lastPushAt: {uid_host: new Date()}});

      for (const sub of SUBCOLLECTIONS) {
        await eventRef.collection(sub).doc("d1").set({marker: sub});
      }

      // Sanity: it really is all there before the delete.
      expect((await chatRef.collection("messages").get()).size).toBe(2);
      expect((await eventRef.collection("benefitRedemptions").get()).size).toBe(1);

      await eventRef.delete();
    });

    await eventually(() => admin(async (db) => {
      const eventRef = db.doc(`event/${EVENT_ID}`);
      const chatRef = db.doc(`eventChat/${EVENT_ID}`);

      expect((await chatRef.get()).exists).toBe(false);
      expect((await chatRef.collection("messages").get()).empty).toBe(true);
      expect((await chatRef.collection("pushState").get()).empty).toBe(true);
      for (const sub of SUBCOLLECTIONS) {
        expect((await eventRef.collection(sub).get()).empty).toBe(true);
      }
    }));
  }, 60000);

  it("is harmless for an event that never had a chat", async () => {
    const id = "evt_nochat_cascade";

    await admin(async (db) => {
      const eventRef = db.doc(`event/${id}`);
      await eventRef.set({name: "No chat", hostRef: db.doc("user/uid_host")});
      await eventRef.collection("question").doc("q1").set({content: "q"});
      await eventRef.delete();
    });

    await eventually(() => admin(async (db) => {
      expect((await db.doc(`event/${id}`).collection("question").get()).empty).toBe(true);
      expect((await db.doc(`eventChat/${id}`).get()).exists).toBe(false);
    }));
  }, 60000);
});
