import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, resolve} from "node:path";
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from "@firebase/rules-unit-testing";
import {doc, setDoc, getDoc} from "firebase/firestore";

const here = dirname(fileURLToPath(import.meta.url));
const rulesPath = resolve(here, "../../firestore.rules");

export {assertSucceeds, assertFails};

// Stable ids so a failure message tells you who the actor was.
export const HOST = "uid_host";
export const MEMBER = "uid_member";
export const MUTED = "uid_muted";
export const BANNED = "uid_banned";
export const JOINER = "uid_joiner"; // in the event, not yet in the chat
export const STRANGER = "uid_stranger";

export const FREE_EVENT = "evt_free";
export const PAID_EVENT = "evt_paid";
export const NO_CHAT_EVENT = "evt_nochat";

export async function makeTestEnv() {
  return initializeTestEnvironment({
    projectId: "gplay-rules-test",
    firestore: {
      rules: readFileSync(rulesPath, "utf8"),
      // `emulators:exec` exports FIRESTORE_EMULATOR_HOST, so a non-default
      // port in firebase.json (e.g. 8080 taken by something else) just works.
      host: (process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":")[0],
      port: Number((process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080").split(":")[1]),
    },
  });
}

/**
 * Seeds the world every suite shares, with rules DISABLED.
 *
 * `participantsRef` holds DocumentReferences (matching the Flutter client), not
 * uid strings — that is what the `hasAny()`-over-references assumption rests on.
 */
export async function seed(testEnv) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const userRef = (uid) => doc(db, "user", uid);

    for (const uid of [HOST, MEMBER, MUTED, BANNED, JOINER, STRANGER]) {
      await setDoc(userRef(uid), {name: uid, verificationLevel: "phone", gTokens: 10, usersRef: []});
    }

    // Free event: everyone but STRANGER is in participantsRef.
    await setDoc(doc(db, "event", FREE_EVENT), {
      name: "Free event",
      photo: "https://example.test/p.jpg",
      hostRef: userRef(HOST),
      isSelling: false,
      participantsRef: [userRef(HOST), userRef(MEMBER), userRef(MUTED), userRef(BANNED), userRef(JOINER)],
      usersPaid: [],
      benefitPhoto: "https://example.test/b.jpg",
      benefitDescription: "2x1 en margaritas",
    });

    // Paid event: MEMBER paid; JOINER was invited free (in participantsRef but
    // NOT usersPaid) — the asymmetry between getEventForViewer and
    // hasJoinedOrPaid lives here.
    await setDoc(doc(db, "event", PAID_EVENT), {
      name: "Paid event",
      hostRef: userRef(HOST),
      isSelling: true,
      currency: "MXN",
      priceCents: 25000,
      participantsRef: [userRef(HOST), userRef(MEMBER), userRef(JOINER)],
      usersPaid: [MEMBER],
    });

    // An event with NO chat doc — exercises get()-returns-null.
    await setDoc(doc(db, "event", NO_CHAT_EVENT), {
      name: "No chat yet",
      hostRef: userRef(HOST),
      isSelling: false,
      participantsRef: [userRef(HOST), userRef(JOINER)],
      usersPaid: [],
    });

    await setDoc(doc(db, "eventChat", FREE_EVENT), {
      eventId: FREE_EVENT,
      eventName: "Free event",
      eventPhoto: "https://example.test/p.jpg",
      hostId: HOST,
      // BANNED is deliberately NOT in `participants` — the host's remove does
      // arrayRemove(participants) + arrayUnion(bannedIds) in one write, so this
      // is the realistic post-removal shape. The degenerate overlap (in both
      // arrays, reachable via a blind rejoin) is covered by its own test.
      participants: [HOST, MEMBER, MUTED],
      mode: "open",
      mutedIds: [MUTED],
      bannedIds: [BANNED],
      lastMessage: "hi",
      lastMessageSenderId: HOST,
      lastMessageSenderName: "host",
      readBy: [HOST],
      isClosed: false,
    });

    await setDoc(doc(db, "eventChat", FREE_EVENT, "messages", "m1"), {
      senderId: MEMBER,
      senderName: "member",
      senderPhoto: "",
      content: "hello",
      type: "text",
      readBy: [MEMBER],
      isDeleted: false,
    });

    await setDoc(doc(db, "eventChat", PAID_EVENT), {
      eventId: PAID_EVENT,
      eventName: "Paid event",
      eventPhoto: "",
      hostId: HOST,
      participants: [HOST, MEMBER],
      mode: "open",
      mutedIds: [],
      bannedIds: [],
      lastMessage: "",
      lastMessageSenderId: "",
      lastMessageSenderName: "",
      readBy: [],
      isClosed: false,
    });

    await setDoc(doc(db, "event", FREE_EVENT, "benefitRedemptions", MEMBER), {
      userId: MEMBER,
      eventId: FREE_EVENT,
      code: "BEN-ABCDE-FGHJK",
      costGShards: 1,
      status: "active",
      benefitDescription: "2x1 en margaritas",
      benefitPhoto: "https://example.test/b.jpg",
    });
  });
}

/** An authenticated Firestore handle for `uid`. */
export function as(testEnv, uid) {
  return testEnv.authenticatedContext(uid).firestore();
}

/** A signed-out handle. */
export function asGuest(testEnv) {
  return testEnv.unauthenticatedContext().firestore();
}

/** An anonymous-auth handle — guests in this app are Firebase anonymous users. */
export function asAnon(testEnv) {
  return testEnv.authenticatedContext("uid_anon", {provider_id: "anonymous"}).firestore();
}

export {doc, setDoc, getDoc};
