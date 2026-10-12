/**
 * §5 event chat: the allow/deny matrix over `eventChat/{eventId}` and its
 * `messages` subcollection.
 *
 * Roles come from helpers.js: HOST, MEMBER (chat participant), MUTED, BANNED,
 * JOINER (in the event, not yet in the chat), STRANGER (in neither).
 */
import {describe, it, beforeAll, afterAll, beforeEach} from "vitest";
import {
  doc, getDoc, setDoc, addDoc, collection, updateDoc, deleteDoc,
  arrayUnion, arrayRemove, serverTimestamp, getDocs,
} from "firebase/firestore";
import {
  makeTestEnv, seed, as, asGuest, assertSucceeds, assertFails,
  HOST, MEMBER, MUTED, BANNED, JOINER, STRANGER,
  FREE_EVENT, PAID_EVENT, NO_CHAT_EVENT,
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

/** Sets chat fields with rules off, for arranging a scenario. */
async function patchChat(eventId, data) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc(`eventChat/${eventId}`).set(data, {merge: true});
  });
}

describe("read: chat document", () => {
  it("allows a chat participant", async () => {
    await assertSucceeds(getDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT)));
  });

  it("allows the host", async () => {
    await assertSucceeds(getDoc(doc(as(testEnv, HOST), "eventChat", FREE_EVENT)));
  });

  // D2 REGRESSION. ensureMembership() opens with exactly this read. Before the
  // fix it was denied for anyone not already in `participants`, the client
  // swallowed it, and Stripe buyers silently never joined the chat.
  it("D2: allows an event member who is not yet a chat participant", async () => {
    await assertSucceeds(getDoc(doc(as(testEnv, JOINER), "eventChat", FREE_EVENT)));
  });

  it("D2: still denies a banned member (no lastMessage preview leak)", async () => {
    await assertFails(getDoc(doc(as(testEnv, BANNED), "eventChat", FREE_EVENT)));
  });

  it("denies a stranger", async () => {
    await assertFails(getDoc(doc(as(testEnv, STRANGER), "eventChat", FREE_EVENT)));
  });

  // Degenerate state: in BOTH `participants` and `bannedIds`. Should be
  // unreachable — removeMember writes both arrays atomically — but the client's
  // joinChat() blind-arrayUnions on rejoin without consulting bannedIds, so it
  // is reachable in principle. Banned must win over stale membership, or a
  // rejoin would silently undo the host's removal.
  it("banned wins over stale participants membership (read)", async () => {
    await patchChat(FREE_EVENT, {participants: [HOST, MEMBER, MUTED, BANNED]});
    await assertFails(getDoc(doc(as(testEnv, BANNED), "eventChat", FREE_EVENT)));
  });

  it("banned wins over stale participants membership (messages)", async () => {
    await patchChat(FREE_EVENT, {participants: [HOST, MEMBER, MUTED, BANNED]});
    await assertFails(getDocs(collection(as(testEnv, BANNED), "eventChat", FREE_EVENT, "messages")));
  });

  it("denies a signed-out client", async () => {
    await assertFails(getDoc(doc(asGuest(testEnv), "eventChat", FREE_EVENT)));
  });
});

describe("create: seeding the chat", () => {
  const seedDoc = (uid, hostId) => ({
    eventId: NO_CHAT_EVENT, eventName: "No chat yet", eventPhoto: "",
    hostId, participants: [uid], mode: "open",
    mutedIds: [], bannedIds: [], lastMessage: "", lastMessageSenderId: "",
    lastMessageSenderName: "", readBy: [], isClosed: false,
  });

  it("allows the host to seed with a truthful hostId", async () => {
    await assertSucceeds(
      setDoc(doc(as(testEnv, HOST), "eventChat", NO_CHAT_EVENT), seedDoc(HOST, HOST)),
    );
  });

  it("allows an event member to seed themselves in", async () => {
    await assertSucceeds(
      setDoc(doc(as(testEnv, JOINER), "eventChat", NO_CHAT_EVENT), seedDoc(JOINER, HOST)),
    );
  });

  it("denies a forged hostId (would grant moderation powers)", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, JOINER), "eventChat", NO_CHAT_EVENT), seedDoc(JOINER, JOINER)),
    );
  });

  it("denies seeding with anyone else pre-added", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, JOINER), "eventChat", NO_CHAT_EVENT), {
        ...seedDoc(JOINER, HOST), participants: [JOINER, STRANGER],
      }),
    );
  });

  it("denies a non-member of the event", async () => {
    await assertFails(
      setDoc(doc(as(testEnv, STRANGER), "eventChat", NO_CHAT_EVENT), seedDoc(STRANGER, HOST)),
    );
  });
});

describe("membership", () => {
  it("lets an event member join themselves", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, JOINER), "eventChat", FREE_EVENT), {participants: arrayUnion(JOINER)}),
    );
  });

  it("denies adding somebody else", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {participants: arrayUnion(STRANGER)}),
    );
  });

  it("denies dropping somebody else", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {participants: arrayRemove(HOST)}),
    );
  });

  it("lets a member leave while still in the event", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {participants: arrayRemove(MEMBER)}),
    );
  });

  // D1 REGRESSION — the whole reason isSelfLeave() exists.
  //
  // The client removes you from the event first (event_repository.dart:602)
  // and only then from the chat (:618). This reproduces that exact ordering:
  // by the time the chat write lands, isEventMember() is already false. Before
  // the fix this was denied, `_syncChatLeave` swallowed it, and you stayed in
  // the chat forever — still reading it, still receiving B2 push.
  it("D1: lets you leave the chat AFTER you have left the event", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`event/${FREE_EVENT}`).update({
        participantsRef: [db.doc(`user/${HOST}`), db.doc(`user/${MUTED}`), db.doc(`user/${BANNED}`)],
      });
    });

    await assertSucceeds(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {participants: arrayRemove(MEMBER)}),
    );
  });

  it("D1: leaving is self-only — cannot evict someone else once out of the event", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await db.doc(`event/${FREE_EVENT}`).update({participantsRef: []});
    });

    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {participants: arrayRemove(HOST)}),
    );
  });

  it("D1: a self-leave cannot smuggle other field changes through", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {
        participants: arrayRemove(MEMBER),
        isClosed: true,
      }),
    );
  });

  it("denies a banned member re-adding themselves", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, BANNED), "eventChat", FREE_EVENT), {participants: arrayUnion(BANNED)}),
    );
  });

  it("denies a stranger joining", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, STRANGER), "eventChat", FREE_EVENT), {participants: arrayUnion(STRANGER)}),
    );
  });

  it("on a PAID event, lets a paying buyer join", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc(`eventChat/${PAID_EVENT}`)
        .set({participants: [HOST]}, {merge: true});
    });
    await assertSucceeds(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", PAID_EVENT), {participants: arrayUnion(MEMBER)}),
    );
  });

  // D3 — THE THREE-WAY ASYMMETRY, pinned here so a future edit has to
  // acknowledge it rather than discover it.
  //
  // JOINER is in the paid event's `participantsRef` but not `usersPaid` — a
  // host-invited free attendee. Three layers disagree about them:
  //
  //   rules isEventMember()          usersPaid OR participantsRef  -> ALLOWED
  //   getEventForViewer()            usersPaid OR participantsRef  -> allowed
  //   client hasJoinedOrPaid()       usersPaid ONLY (paid events)  -> hidden
  //   redeemEventBenefit() callable  usersPaid ONLY                -> denied
  //
  // So the app hides the chat from them while the rules would permit it, and
  // they can never redeem a benefit. Nothing leaks — they are a legitimate
  // attendee the host invited — but the tiers should be reconciled. This test
  // asserts the CURRENT deliberate rules behaviour; if the product decision
  // goes the other way, tighten isEventMember and flip this to assertFails.
  it("D3: on a PAID event, rules ALLOW an invited-but-unpaid attendee (client hides it)", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, JOINER), "eventChat", PAID_EVENT), {participants: arrayUnion(JOINER)}),
    );
  });
});

describe("read receipts and thread summary", () => {
  it("lets a member mark read", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {readBy: arrayUnion(MEMBER)}),
    );
  });

  it("lets a member write the thread summary when they may post", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {
        lastMessage: "hey", lastMessageSenderId: MEMBER,
        lastMessageSenderName: "member", lastMessageTimestamp: serverTimestamp(),
        readBy: [MEMBER],
      }),
    );
  });

  it("denies forging a summary as another sender", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), {
        lastMessage: "hey", lastMessageSenderId: HOST,
        lastMessageSenderName: "host", lastMessageTimestamp: serverTimestamp(),
      }),
    );
  });

  it("denies a MUTED member writing a summary", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MUTED), "eventChat", FREE_EVENT), {
        lastMessage: "hey", lastMessageSenderId: MUTED,
        lastMessageSenderName: "muted", lastMessageTimestamp: serverTimestamp(),
      }),
    );
  });

  it("denies a member touching moderation state", async () => {
    for (const patch of [{mode: "announcements"}, {isClosed: true},
      {mutedIds: arrayUnion(HOST)}, {bannedIds: arrayUnion(HOST)}]) {
      await assertFails(updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT), patch));
    }
  });
});

describe("host moderation", () => {
  it("lets the host switch mode, close, mute and ban", async () => {
    const db = as(testEnv, HOST);
    for (const patch of [{mode: "announcements"}, {isClosed: true},
      {mutedIds: arrayUnion(MEMBER)}, {bannedIds: arrayUnion(MEMBER)}]) {
      await assertSucceeds(updateDoc(doc(db, "eventChat", FREE_EVENT), patch));
    }
  });

  it("lets the host remove a member outright", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, HOST), "eventChat", FREE_EVENT), {
        participants: arrayRemove(MEMBER), bannedIds: arrayUnion(MEMBER),
      }),
    );
  });

  it("denies a non-host deleting the chat", async () => {
    await assertFails(deleteDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT)));
  });
});

describe("messages", () => {
  const message = (senderId) => ({
    senderId, senderName: senderId, senderPhoto: "",
    content: "hello", timestamp: serverTimestamp(),
    type: "text", readBy: [senderId], isDeleted: false,
  });

  it("lets a participant read messages", async () => {
    await assertSucceeds(getDocs(collection(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages")));
  });

  it("denies a non-participant reading messages, even as an event member", async () => {
    await assertFails(getDocs(collection(as(testEnv, JOINER), "eventChat", FREE_EVENT, "messages")));
  });

  it("denies a banned member reading messages", async () => {
    await assertFails(getDocs(collection(as(testEnv, BANNED), "eventChat", FREE_EVENT, "messages")));
  });

  it("lets a participant send", async () => {
    await assertSucceeds(
      addDoc(collection(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages"), message(MEMBER)),
    );
  });

  it("denies sending as someone else", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages"), message(HOST)),
    );
  });

  it("denies a MUTED member sending", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, MUTED), "eventChat", FREE_EVENT, "messages"), message(MUTED)),
    );
  });

  it("denies a BANNED member sending", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, BANNED), "eventChat", FREE_EVENT, "messages"), message(BANNED)),
    );
  });

  it("denies everyone once the chat is closed, host included", async () => {
    await patchChat(FREE_EVENT, {isClosed: true});
    for (const uid of [MEMBER, HOST]) {
      await assertFails(
        addDoc(collection(as(testEnv, uid), "eventChat", FREE_EVENT, "messages"), message(uid)),
      );
    }
  });

  it("in announcements mode, denies a member and allows the host", async () => {
    await patchChat(FREE_EVENT, {mode: "announcements"});
    await assertFails(
      addDoc(collection(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages"), message(MEMBER)),
    );
    await assertSucceeds(
      addDoc(collection(as(testEnv, HOST), "eventChat", FREE_EVENT, "messages"), message(HOST)),
    );
  });

  it("denies creating a message already flagged deleted", async () => {
    await assertFails(
      addDoc(collection(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages"),
        {...message(MEMBER), isDeleted: true}),
    );
  });

  it("lets the host soft-delete any message", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, HOST), "eventChat", FREE_EVENT, "messages", "m1"),
        {isDeleted: true, deletedBy: HOST, deletedAt: serverTimestamp()}),
    );
  });

  it("denies a member soft-deleting — even their OWN message", async () => {
    // m1 was sent by MEMBER. Deletion is a moderation power, not an authorship
    // one; the client only offers it to the host.
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages", "m1"),
        {isDeleted: true, deletedBy: MEMBER, deletedAt: serverTimestamp()}),
    );
  });

  it("lets a participant mark a message read", async () => {
    await assertSucceeds(
      updateDoc(doc(as(testEnv, HOST), "eventChat", FREE_EVENT, "messages", "m1"),
        {readBy: arrayUnion(HOST)}),
    );
  });

  it("denies editing message content", async () => {
    await assertFails(
      updateDoc(doc(as(testEnv, MEMBER), "eventChat", FREE_EVENT, "messages", "m1"),
        {content: "edited"}),
    );
  });
});

describe("pushState is server-only", () => {
  // Written by eventChatMessagePush with admin privileges (rules bypassed).
  // Intentionally unmatched by any rule, so every client is denied.
  it("denies reads and writes even to the host", async () => {
    const db = as(testEnv, HOST);
    await assertFails(getDoc(doc(db, "eventChat", FREE_EVENT, "pushState", "state")));
    await assertFails(setDoc(doc(db, "eventChat", FREE_EVENT, "pushState", "state"), {lastPushAt: {}}));
  });
});
