/**
 * B2 — `eventChatMessagePush` recipient resolution and cooldown.
 *
 * FCM cannot deliver against the emulator (no credentials), but delivery is not
 * the interesting part — WHO gets picked is. `claimEventChatPushSlots` writes
 * `eventChat/{id}/pushState/state.lastPushAt` BEFORE the send, so the recipient
 * set and the cooldown are both fully observable even when `sendEach` fails.
 *
 * Needs both emulators: `npm run test:functions`.
 */
import {describe, it, beforeAll, afterAll, beforeEach, expect} from "vitest";
import {makeTestEnv} from "../rules/helpers.js";

const EVENT_ID = "evt_push";
const SENDER = "uid_sender";
const PLAIN = "uid_plain";
const MUTED = "uid_muted_push";
const BANNED = "uid_banned_push";
const BLOCKER = "uid_blocker"; // has blocked SENDER

let testEnv;

// withSecurityRulesDisabled() resolves to void — it does NOT forward the
// callback's return value — so capture it rather than returning through.
async function admin(fn) {
  let result;
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    result = await fn(ctx.firestore());
  });
  return result;
}

async function eventually(check, {timeoutMs = 25000, intervalMs = 400} = {}) {
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

/** `lastPushAt` keys currently stamped, i.e. who was actually pushed to. */
async function pushedUids() {
  return admin(async (db) => {
    const snap = await db.doc(`eventChat/${EVENT_ID}/pushState/state`).get();
    if (!snap.exists) return [];
    return Object.keys(snap.get("lastPushAt") || {}).sort();
  });
}

async function sendMessage(fields = {}) {
  return admin(async (db) => {
    const ref = await db.collection(`eventChat/${EVENT_ID}/messages`).add({
      senderId: SENDER,
      senderName: "Sender",
      senderPhoto: "",
      content: "hello everyone",
      type: "text",
      readBy: [SENDER],
      isDeleted: false,
      timestamp: new Date(),
      ...fields,
    });
    return ref.id;
  });
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
    for (const uid of [SENDER, PLAIN, MUTED, BANNED, BLOCKER]) {
      await db.doc(`user/${uid}`).set({name: uid, usersRef: [], notifications: []});
    }
    // BLOCKER has blocked SENDER — `usersRef` holds DocumentReferences.
    await db.doc(`user/${BLOCKER}`).set({
      name: BLOCKER,
      usersRef: [db.doc(`user/${SENDER}`)],
      notifications: [],
    }, {merge: true});

    await db.doc(`eventChat/${EVENT_ID}`).set({
      eventId: EVENT_ID,
      eventName: "Push test",
      eventPhoto: "",
      hostId: SENDER,
      participants: [SENDER, PLAIN, MUTED, BANNED, BLOCKER],
      mode: "open",
      mutedIds: [MUTED],
      bannedIds: [BANNED],
      isClosed: false,
    });
  });
});

describe("B2 eventChatMessagePush", () => {
  it("pushes to members minus sender, banned and blockers — but KEEPS muted", async () => {
    await sendMessage();

    await eventually(async () => {
      // Muted means "cannot post", not "cannot hear" — suppressing their push
      // would make mute indistinguishable from a ban.
      expect(await pushedUids()).toEqual([MUTED, PLAIN].sort());
    });
  }, 40000);

  it("respects the per-user cooldown on a second message", async () => {
    await sendMessage();
    await eventually(async () => expect((await pushedUids()).length).toBe(2));

    const before = await admin(async (db) => {
      const snap = await db.doc(`eventChat/${EVENT_ID}/pushState/state`).get();
      return snap.get("lastPushAt")[PLAIN].toMillis();
    });

    await sendMessage({content: "second message"});
    // Give the trigger time to run and decide against re-pushing.
    await new Promise((r) => setTimeout(r, 4000));

    const after = await admin(async (db) => {
      const snap = await db.doc(`eventChat/${EVENT_ID}/pushState/state`).get();
      return snap.get("lastPushAt")[PLAIN].toMillis();
    });

    expect(after).toBe(before);
  }, 40000);

  it("bypasses the cooldown in announcements mode", async () => {
    await sendMessage();
    await eventually(async () => expect((await pushedUids()).length).toBe(2));

    const before = await admin(async (db) => {
      const snap = await db.doc(`eventChat/${EVENT_ID}/pushState/state`).get();
      return snap.get("lastPushAt")[PLAIN].toMillis();
    });

    await admin((db) => db.doc(`eventChat/${EVENT_ID}`).set({mode: "announcements"}, {merge: true}));
    await new Promise((r) => setTimeout(r, 50));
    await sendMessage({content: "announcement"});

    await eventually(async () => {
      const after = await admin(async (db) => {
        const snap = await db.doc(`eventChat/${EVENT_ID}/pushState/state`).get();
        return snap.get("lastPushAt")[PLAIN].toMillis();
      });
      expect(after).toBeGreaterThan(before);
    });
  }, 40000);

  it("does not push for system messages, deletions, empty content, or a closed chat", async () => {
    const cases = [
      {type: "system", content: "uid joined"},
      {isDeleted: true},
      {content: "   "},
    ];

    for (const patch of cases) {
      await testEnv.clearFirestore();
      await admin(async (db) => {
        await db.doc(`user/${PLAIN}`).set({name: PLAIN, usersRef: []});
        await db.doc(`eventChat/${EVENT_ID}`).set({
          eventId: EVENT_ID, hostId: SENDER, participants: [SENDER, PLAIN],
          mutedIds: [], bannedIds: [], isClosed: false, mode: "open",
        });
      });
      await sendMessage(patch);
      await new Promise((r) => setTimeout(r, 3000));
      expect(await pushedUids(), `case ${JSON.stringify(patch)}`).toEqual([]);
    }

    // Closed chat.
    await testEnv.clearFirestore();
    await admin(async (db) => {
      await db.doc(`user/${PLAIN}`).set({name: PLAIN, usersRef: []});
      await db.doc(`eventChat/${EVENT_ID}`).set({
        eventId: EVENT_ID, hostId: SENDER, participants: [SENDER, PLAIN],
        mutedIds: [], bannedIds: [], isClosed: true, mode: "open",
      });
    });
    await sendMessage();
    await new Promise((r) => setTimeout(r, 3000));
    expect(await pushedUids()).toEqual([]);
  }, 60000);
});
