/* eslint-disable no-undef */
/* eslint-disable max-len */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe")(functions.config().stripe.secret);
admin.initializeApp();

const {FieldValue, Timestamp} = admin.firestore;

exports.checkEmail = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const email = req.body.email;

  try {
    const userRecord = await admin.auth().getUserByEmail(email);

    return res.status(200).send({exists: true, methods: userRecord.providerData.map((provider) => provider.providerId)});
  } catch (error) {
    if (error.code === "auth/user-not-found") {
      return res.status(200).send({exists: false});
    } else {
      return res.status(500).send({
        error: "internal",
        message: "Error checking email",
        details: error.message,
      });
    }
  }
});

exports.deleteUser = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    // Manejar solicitudes preflight
    res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    res.status(204).send("");
    return;
  }

  if (req.method !== "DELETE") {
    return res.status(405).send("Method not allowed");
  }

  const {uid} = req.body;

  if (!uid) {
    return res.status(400).send({
      error: "bad-request",
      message: "The UID is required",
    });
  }

  try {
    await admin.auth().deleteUser(uid);
    return res.status(200).send({
      message: "User deleted successfully",
    });
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error deleting the user",
      details: error.message,
    });
  }
});

exports.getUsersByLoginDate = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {startDate, endDate} = req.body;

  if (!startDate || !endDate) {
    return res.status(400).send({
      error: "bad-request",
      message: "The start date and end date are required",
    });
  }

  try {
    const users = await admin.auth().listUsers();
    const start = new Date(startDate).getTime();
    const end = new Date(endDate).getTime();

    const activeUsers = users.users.filter((user) => {
      const lastLogin = user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime).getTime() : 0;
      return lastLogin >= start && lastLogin <= end;
    });

    return res.status(200).send({activeUsers});
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error getting users",
      details: error.message,
    });
  }
});

exports.putNotificationUser = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId, title, content, notificationType} = req.body;

  if (!userId || !title || !content || !notificationType) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, title, content and notificationType of the pust notification user are required",
    });
  }

  const notificationData = {
    title,
    content,
    notificationType,
    isRead: false,
    date: Timestamp.now(),
    eventId: "",
    eventHost: "",
    image: "",
    navigation: "",
  };

  try {
    await admin.firestore().collection("user").doc(userId).update({
      notifications: FieldValue.arrayUnion(notificationData),
    });

    return res.status(200).send({
      message: "Notification added successfully",
    });
  } catch (error) {
    console.error("Error adding notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error adding notification",
      details: error.message,
    });
  }
});

exports.sendNotificationByInterest = functions.firestore.document("event/{eventId}").onCreate(async (snap, context) => {
  const eventData = snap.data();

  const message = {
    notification: {
      title: "Event Just for You!",
      body: "We found an event that matches your interests. Don’t miss out—check it out now and see if it’s the perfect fit!",
      image: eventData.photo,
    },
    data: {
      notification: "1",
      information: JSON.stringify({
        eventId: snap.id,
        eventHost: eventData.hostRef.id,
      }),
      image: eventData.photo,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${eventData.interestList.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${eventData.interestList.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}-${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    const usersRef = admin.firestore().collection("user")
        .where("eventInterest", "array-contains", eventData.interestList)
        .where("state", "==", eventData.state);

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Event Just for You!",
            content: "We found an event that matches your interests. Don’t miss out—check it out now and see if it’s the perfect fit!",
            notificationType: "1",
            isRead: false,
            date: Timestamp.now(),
            image: eventData.photo,
            eventId: snap.id,
            eventHost: eventData.hostRef.id,
            navigation: "eventdetail",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error("Error sending notification sendNotificationByInterest:", error);
  }
});

exports.sendNotificationInviteUser = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {inviteUser, eventName, eventPhoto, eventId, guestId} = req.body;

  if (!inviteUser || !eventName || !eventPhoto || !eventId || !guestId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The inviteUser, eventName, eventPhoto, eventId and guestId of the notification are required",
    });
  }

  const message = {
    notification: {
      title: "You've Got an Invite!",
      body: `${inviteUser} just invited you to join the event ${eventName}! Ready to RSVP? Accept or decline—it’s your call!`,
      image: eventPhoto,
    },
    data: {
      notification: "2",
      information: JSON.stringify({
        eventId: eventId,
      }),
      image: eventPhoto,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${guestId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${guestId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    await admin.firestore().collection("user").doc(guestId).update({
      notifications: FieldValue.arrayUnion({
        title: "You've Got an Invite!",
        content: `${inviteUser} just invited you to join the event ${eventName}! Ready to RSVP? Accept or decline—it’s your call!`,
        notificationType: "2",
        isRead: false,
        date: Timestamp.now(),
        image: eventPhoto,
        eventId: eventId,
        eventHost: "",
        navigation: "myevents",
      }),
    });

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationInviteUser notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationInviteUser notification",
      details: error.message,
    });
  }
});

exports.sendNotificationByState = functions.firestore.document("event/{eventId}").onCreate(async (snap, context) => {
  const eventData = snap.data();

  const message = {
    notification: {
      title: "New Events Nearby!",
      body: "New events just popped up near you! Dive in and see what's happening around town!",
      image: eventData.photo,
    },
    data: {
      notification: "3",
      information: JSON.stringify({
        eventId: snap.id,
        eventHost: eventData.hostRef.id,
      }),
      image: eventData.photo,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    const usersRef = admin.firestore().collection("user")
        .where("state", "==", eventData.state);

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "New Events Nearby!",
            content: "New events just popped up near you! Dive in and see what's happening around town!",
            notificationType: "3",
            isRead: false,
            date: Timestamp.now(),
            image: eventData.photo,
            eventId: snap.id,
            eventHost: eventData.hostRef.id,
            navigation: "eventdetail",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error("Error sending notification sendNotificationByState:", error);
  }
});

exports.sendNotificationEventsReminder = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(today);
  endDate.setUTCDate(today.getUTCDate() + 7);
  endDate.setUTCHours(23, 59, 59, 999);

  console.log(`Searching for events from today (${today.toISOString().slice(0, 10)}) to ${endDate.toISOString().slice(0, 10)}`);

  try {
    const snapshot = await admin.firestore().collection("event")
        .where("startDate", ">=", today)
        .where("startDate", "<=", endDate)
        .get();

    if (snapshot.empty) {
      console.log("No events found in the next 7 days");
      return null;
    }

    snapshot.forEach(async (doc) => {
      const eventData = doc.data();
      const eventId = doc.id;

      console.log(`Event found: ${eventId}`, eventData);

      const message = {
        notification: {
          title: "Event Reminder!",
          body: `Your event '${eventData.name}' is coming up soon! Are you ready for it?`,
          image: eventData.photo,
        },
        data: {
          notification: "4",
          information: JSON.stringify({
            eventId: eventId,
            eventHost: eventData.hostRef.id,
          }),
          image: eventData.photo,
          date: new Date().toISOString(),
        },
        android: {
          notification: {
            sound: "default",
            priority: "high",
            channelId: "high_importance_channel",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
        topic: `${eventId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
      };

      try {
        const response = await admin.messaging().send(message);
        console.log(`Notification successfully sent to the topic: ${eventId}: ${response}`);

        const usersRef = admin.firestore().collection("user")
            .where("attendedEventsRef", "array-contains", admin.firestore().doc(`event/${eventId}`));

        const batchSize = 500;
        let lastDoc = null;
        let hasMoreDocuments = true;

        while (hasMoreDocuments) {
          let query = usersRef.limit(batchSize);
          if (lastDoc) {
            query = query.startAfter(lastDoc);
          }

          const usersSnapshot = await query.get();
          if (usersSnapshot.empty) {
            hasMoreDocuments = false;
            break;
          }

          const batch = admin.firestore().batch();
          usersSnapshot.forEach((doc) => {
            const userRef = doc.ref;
            batch.update(userRef, {
              notifications: admin.firestore.FieldValue.arrayUnion({
                title: "Event Reminder!",
                content: `Your event '${eventData.name}' is coming up soon! Are you ready for it?`,
                notificationType: "4",
                isRead: false,
                date: Timestamp.now(),
                image: eventData.photo,
                eventId: eventId,
                eventHost: eventData.hostRef.id,
                navigation: "eventdetail",
              }),
            });
          });

          await batch.commit();
          lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
        }

        console.log("Notifications successfully added to user documents.");
      } catch (error) {
        console.error(`Error sending notification sendNotificationEventsReminder for event ${eventId}:`, error);
      }
    });
  } catch (error) {
    console.error("Error getting events:", error);
  }

  return null;
});

exports.sendNotificationEventFinish = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {eventPhoto, eventId, hostId} = req.body;

  if (!eventPhoto || !eventId || !hostId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The eventPhoto, eventId and hostId of the notification are required",
    });
  }

  const message = {
    notification: {
      title: "Event Feedback",
      body: "The event has ended. Share your thoughts by leaving a review for others!",
      image: eventPhoto,
    },
    data: {
      notification: "5",
      information: JSON.stringify({
        eventId: eventId,
        eventHost: hostId,
      }),
      image: eventPhoto,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${eventId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${eventId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    const usersRef = admin.firestore().collection("user")
        .where("attendedEventsRef", "array-contains", admin.firestore().doc(`event/${eventId}`));

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Event Feedback",
            content: "The event has ended. Share your thoughts by leaving a review for others!",
            notificationType: "5",
            isRead: false,
            date: Timestamp.now(),
            image: eventPhoto,
            eventId: eventId,
            eventHost: hostId,
            navigation: "eventdetail",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationEventFinish notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationEventFinish notification",
      details: error.message,
    });
  }
});

exports.sendNotificationLastMinutes = functions.firestore.document("event/{eventId}").onCreate(async (snap, context) => {
  const eventData = snap.data();

  const startDate = eventData.startDate.toDate();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const eventStartDate = new Date(startDate);
  eventStartDate.setHours(0, 0, 0, 0);

  if (eventStartDate.getTime() !== today.getTime()) {
    console.log("The event is not today. Notification will not be sent.");
    return null;
  }

  const message = {
    notification: {
      title: "Last-Minute Events",
      body: "Last-minute events have just popped up. Interested in attending one?",
      image: eventData.photo,
    },
    data: {
      notification: "6",
      information: JSON.stringify({
        eventId: snap.id,
        eventHost: eventData.hostRef.id,
      }),
      image: eventData.photo,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${eventData.state.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    const usersRef = admin.firestore().collection("user")
        .where("state", "==", eventData.state);

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Last-Minute Events",
            content: "Last-minute events have just popped up. Interested in attending one?",
            notificationType: "6",
            isRead: false,
            date: Timestamp.now(),
            image: eventData.photo,
            eventId: snap.id,
            eventHost: eventData.hostRef.id,
            navigation: "eventdetail",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error("Error sending notification sendNotificationLastMinutes:", error);
  }
});

exports.sendNotificationEventsReminderFavorite = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const endDate = new Date(today);
  endDate.setUTCDate(today.getUTCDate() + 7);
  endDate.setUTCHours(23, 59, 59, 999);

  console.log(`Searching for events from today (${today.toISOString().slice(0, 10)}) to ${endDate.toISOString().slice(0, 10)}`);

  try {
    const snapshot = await admin.firestore().collection("event")
        .where("startDate", ">=", today)
        .where("startDate", "<=", endDate)
        .get();

    if (snapshot.empty) {
      console.log("No events found in the next 7 days favorite");
      return null;
    }

    snapshot.forEach(async (doc) => {
      const eventData = doc.data();
      const eventId = doc.id;

      const startDate = eventData.startDate.toDate();
      const differenceInTime = startDate.getTime() - today.getTime();
      const daysLeft = Math.ceil(differenceInTime / (1000 * 3600 * 24));

      console.log(`Event found: ${eventId}`, eventData);

      const message = {
        notification: {
          title: "Favorite Event Reminder",
          body: `The event '${eventData.name}' you favorited is happening in ${daysLeft} days. Are you going to join?`,
          image: eventData.photo,
        },
        data: {
          notification: "7",
          information: JSON.stringify({
            eventId: eventId,
            eventHost: eventData.hostRef.id,
          }),
          image: eventData.photo,
          date: new Date().toISOString(),
        },
        android: {
          notification: {
            sound: "default",
            priority: "high",
            channelId: "high_importance_channel",
          },
        },
        apns: {
          payload: {
            aps: {
              sound: "default",
            },
          },
        },
        topic: `favorite-${eventId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
      };

      try {
        const response = await admin.messaging().send(message);
        console.log(`Notification successfully sent to the topic: ${eventId}: ${response}`);

        const usersRef = admin.firestore().collection("user")
            .where("favoriteEventsRef", "array-contains", admin.firestore().doc(`event/${eventId}`));

        const batchSize = 500;
        let lastDoc = null;
        let hasMoreDocuments = true;

        while (hasMoreDocuments) {
          let query = usersRef.limit(batchSize);
          if (lastDoc) {
            query = query.startAfter(lastDoc);
          }

          const usersSnapshot = await query.get();
          if (usersSnapshot.empty) {
            hasMoreDocuments = false;
            break;
          }

          const batch = admin.firestore().batch();
          usersSnapshot.forEach((doc) => {
            const userRef = doc.ref;
            batch.update(userRef, {
              notifications: admin.firestore.FieldValue.arrayUnion({
                title: "Favorite Event Reminder",
                content: `The event '${eventData.name}' you favorited is happening in ${daysLeft} days. Are you going to join?`,
                notificationType: "7",
                isRead: false,
                date: Timestamp.now(),
                image: eventData.photo,
                eventId: eventId,
                eventHost: eventData.hostRef.id,
                navigation: "eventdetail",
              }),
            });
          });

          await batch.commit();
          lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
        }

        console.log("Notifications successfully added to user documents.");
      } catch (error) {
        console.error(`Error sending notification for event ${eventId}:`, error);
      }
    });
  } catch (error) {
    console.error("Error getting events:", error);
  }

  return null;
});

exports.sendNotificationNewMessage = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userPhoto, userName, hostId, receiverId} = req.body;

  if (!userPhoto || !userName || !hostId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userPhoto, userName and hostId of the notification are required",
    });
  }

  const message = {
    notification: {
      title: "New Message",
      body: `${userName} just sent you a message. Check it out!`,
      image: userPhoto,
    },
    data: {
      notification: "8",
      information: JSON.stringify({
        eventHost: hostId,
      }),
      image: userPhoto,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `chat-${receiverId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${receiverId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    await admin.firestore().collection("user").doc(receiverId).update({
      notifications: FieldValue.arrayUnion({
        title: "New Message",
        content: `${userName} just sent you a message. Check it out!`,
        notificationType: "8",
        isRead: false,
        date: Timestamp.now(),
        image: userPhoto,
        eventId: "",
        eventHost: hostId,
        navigation: "chats",
      }),
    });

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationNewMessage notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationNewMessage notification",
      details: error.message,
    });
  }
});

exports.sendNotificationRateApp = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
  const message = {
    notification: {
      title: "Rate the App",
      body: "We’d love your feedback! Take a moment to rate our app.",
      image: "",
    },
    data: {
      notification: "9",
      information: JSON.stringify({
        eventHost: "",
      }),
      image: "",
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: "allUser",
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic sendNotificationRateApp: ${response}`);

    const usersRef = admin.firestore().collection("user");

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Rate the App",
            content: "We’d love your feedback! Take a moment to rate our app.",
            notificationType: "9",
            isRead: false,
            date: Timestamp.now(),
            image: "",
            eventHost: "",
            navigation: "",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error(`Error sending notification for event sendNotificationRateApp:`, error);
  }
});

exports.sendNotificationCreateEvent = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
  const eventInterestsSnapshot = await admin.firestore().collection("eventInterest")
      .where("isSuggested", "==", false)
      .get();

  const namesList = [];
  eventInterestsSnapshot.forEach((doc) => {
    namesList.push(doc.data().name);
  });

  const randomIndex = Math.floor(Math.random() * namesList.length);
  const selectedName = namesList[randomIndex];

  const message = {
    notification: {
      title: "Create an Event",
      body: `Thinking of creating an event for ${selectedName} interest? Get started now!`,
      image: "",
    },
    data: {
      notification: "10",
      information: JSON.stringify({
        eventHost: "",
      }),
      image: "",
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: "allUser",
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic sendNotificationCreateEvent: ${response}`);

    const usersRef = admin.firestore().collection("user");

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Create an Event",
            content: `Thinking of creating an event for ${selectedName} interest? Get started now!`,
            notificationType: "10",
            isRead: false,
            date: Timestamp.now(),
            image: "",
            eventHost: "",
            navigation: "createevent",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error(`Error sending notification for event sendNotificationCreateEvent:`, error);
  }
});

exports.sendNotificationRecurringEvent = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
  const message = {
    notification: {
      title: "Recurring Event Promotion",
      body: "You marked your event as recurring! Would you like to promote it with paid advertising?",
      image: "",
    },
    data: {
      notification: "12",
      information: JSON.stringify({
        eventHost: "",
      }),
      image: "",
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: "allUser",
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic sendNotificationRecurringEvent: ${response}`);

    const usersRef = admin.firestore().collection("user");

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Recurring Event Promotion",
            content: "You marked your event as recurring! Would you like to promote it with paid advertising?",
            notificationType: "12",
            isRead: false,
            date: Timestamp.now(),
            image: "",
            eventHost: "",
            navigation: "createevent",
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
  } catch (error) {
    console.error(`Error sending notification for event sendNotificationRecurringEvent:`, error);
  }
});

exports.sendNotificationQuestionUser = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId, eventPhoto, eventId} = req.body;

  if (!userId || !eventPhoto || !eventId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, eventId and eventPhoto of the notification are required",
    });
  }

  const message = {
    notification: {
      title: "User Event Question!",
      body: "Someone has a question about your event. Head over to check it out!",
      image: eventPhoto,
    },
    data: {
      notification: "13",
      information: JSON.stringify({
        eventId: eventId,
      }),
      image: eventPhoto,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log(`Notification successfully sent to the topic: ${userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

    await admin.firestore().collection("user").doc(userId).update({
      notifications: FieldValue.arrayUnion({
        title: "User Event Question!",
        content: "Someone has a question about your event. Head over to check it out!",
        notificationType: "13",
        isRead: false,
        date: Timestamp.now(),
        image: eventPhoto,
        eventId: eventId,
        navigation: "eventdetail",
      }),
    });

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationQuestionUser notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationQuestionUser notification",
      details: error.message,
    });
  }
});

exports.sendNotificationAdmin = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {titleMessage, bodyMessage, imageMessage, urlMessage} = req.body;

  if (!titleMessage || !bodyMessage) {
    return res.status(400).send({
      error: "bad-request",
      message: "The titleMessage and bodyMessage of the notification are required",
    });
  }

  const message = {
    notification: {
      title: titleMessage,
      body: bodyMessage,
    },
    data: {
      notification: "14",
      image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
      url: urlMessage == undefined && urlMessage == null ? "" : urlMessage,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: "allUser",
  };

  try {
    await admin.messaging().send(message);
    console.log("Notification successfully sent to the topic: sendNotificationRecurringEvent");

    const usersRef = admin.firestore().collection("user");

    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;

    while (hasMoreDocuments) {
      let query = usersRef.limit(batchSize);
      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const usersSnapshot = await query.get();
      if (usersSnapshot.empty) {
        hasMoreDocuments = false;
        break;
      }

      const batch = admin.firestore().batch();
      usersSnapshot.forEach((doc) => {
        const userRef = doc.ref;
        batch.update(userRef, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: titleMessage,
            content: bodyMessage,
            notificationType: "14",
            isRead: false,
            date: Timestamp.now(),
            image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
            navigation: "",
            url: urlMessage == undefined && urlMessage == null ? "" : urlMessage,
          }),
        });
      });

      await batch.commit();
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
    }

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationAdmin notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationAdmin notification",
      details: error.message,
    });
  }
});

exports.createCustomAccount = functions.https.onCall(async (data, context) => {
  try {
    const accountData = {
      type: "custom",
      country: data.country,
      business_type: "individual",
      capabilities: {
        transfers: {requested: true},
        card_payments: {requested: true},
      },
    };

    if (data.email) {
      accountData.email = data.email;
    } else if (data.phone) {
      accountData.individual = {
        phone: data.phone,
      };
    }

    const account = await stripe.accounts.create(accountData);
    return {accountId: account.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.updateCustomAccount = functions.https.onCall(async (data, context) => {
  try {
    const accountData = {
      individual: {
        first_name: data.firstName,
        last_name: data.lastName,
        dob: {day: data.day, month: data.month, year: data.year},
        address: {
          line1: data.line1,
          postal_code: data.postalCode,
          city: data.city,
          state: data.state,
          country: data.country,
        },
        email: data.email,
        phone: data.phone,
      },
      business_profile: {
        mcc: data.mcc,
        url: data.website,
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: context.rawRequest.ip,
      },
    };

    if (data.country === "MX") {
      accountData.individual.id_number = data.rfc;
      accountData.individual.verification = {
        document: {
          front: data.documentFront,
          back: data.documentBack,
        },
      };
    } else if (data.country === "US") {
      accountData.individual.ssn_last_4 = data.ssn;
      accountData.individual.verification = {
        document: {
          front: data.documentFront,
          back: data.documentBack,
        },
      };
    }

    const updatedAccount = await stripe.accounts.update(data.accountId, accountData);
    return {success: true, account: updatedAccount};
  } catch (error) {
    return {success: false, message: error.message};
  }
});

exports.addCard = functions.https.onCall(async (data, context) => {
  try {
    const card = await stripe.accounts.createExternalAccount(data.accountId, {
      external_account: data.token,
    });
    return {success: true, cardId: card.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.acceptTos = functions.https.onCall(async (data, context) => {
  try {
    await stripe.accounts.update(data.accountId, {
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: context.rawRequest.ip,
      },
    });
    return {success: true};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.uploadDocument = functions.https.onCall(async (data, context) => {
  try {
    const documentFile = await stripe.files.create({
      purpose: "identity_document",
      file: {
        data: Buffer.from(data.documentData, "base64"),
        name: "document.jpg",
        type: "application/octet-stream",
      },
    });
    return {fileId: documentFile.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.createTransfer = functions.https.onCall(async (data, context) => {
  try {
    const transfer = await stripe.transfers.create({
      amount: data.amount,
      currency: "mxn",
      destination: data.accountId,
    });
    return {transferId: transfer.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.createPayout = functions.https.onCall(async (data, context) => {
  try {
    const payout = await stripe.payouts.create({
      amount: data.amount,
      currency: "mxn",
    }, {
      stripeAccount: data.accountId,
    });
    return {payoutId: payout.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.createPayoutDestination = functions.https.onCall(async (data, context) => {
  try {
    const payout = await stripe.payouts.create({
      amount: data.amount,
      currency: "mxn",
      destination: data.cardId,
    }, {
      stripeAccount: data.accountId,
    });
    return {payoutId: payout.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.getBankAccount = functions.https.onCall(async (data, context) => {
  try {
    const accountId = data.accountId;

    const bankAccounts = await stripe.accounts.listExternalAccounts(accountId, {
      object: "bank_account",
    });

    return {bankAccounts: bankAccounts.data};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.addBankAccount = functions.https.onCall(async (data, context) => {
  try {
    const accountId = data.accountId;
    const clabeNumber = data.clabeNumber;
    const userName = data.userName;
    const countryCode = data.countryCode;
    const currency = data.currency;

    const token = await stripe.tokens.create({
      bank_account: {
        country: countryCode,
        currency: currency,
        account_holder_name: userName,
        account_holder_type: "individual",
        account_number: clabeNumber,
      },
    });

    const bankAccount = await stripe.accounts.createExternalAccount(accountId, {
      external_account: token.id,
    });

    return {success: true, bankAccountId: bankAccount.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.createPaymentIntent = functions.https.onCall(async (data, context) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: data.amount,
      currency: data.currency,
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
    });

    return {success: true, clientSecret: paymentIntent.client_secret, id: paymentIntent.id};
  } catch (error) {
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.sendNotificationAdminStrikes = functions.https.onRequest(async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "POST");
  res.set("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    res.set("Access-Control-Max-Age", "3600");
    return res.status(204).send("");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {titleMessage, bodyMessage, imageMessage, urlMessage, userId} = req.body;

  if (!titleMessage || !bodyMessage) {
    return res.status(400).send({
      error: "bad-request",
      message: "The titleMessage and bodyMessage of the notification are required",
    });
  }

  const message = {
    notification: {
      title: titleMessage,
      body: bodyMessage,
    },
    data: {
      notification: "15",
      image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
      url: urlMessage == undefined && urlMessage == null ? "" : urlMessage,
      date: new Date().toISOString(),
    },
    android: {
      notification: {
        sound: "default",
        priority: "high",
        channelId: "high_importance_channel",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
    topic: `${userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
  };

  try {
    await admin.messaging().send(message);
    console.log("Notification successfully sent to the topic: sendNotificationAdminStrikes");

    await admin.firestore().collection("user").doc(userId).update({
      notifications: FieldValue.arrayUnion({
        title: titleMessage,
        content: bodyMessage,
        notificationType: "15",
        isRead: false,
        date: Timestamp.now(),
        image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
        navigation: "",
        url: urlMessage == undefined && urlMessage,
      }),
    });

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationAdmin notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationAdmin notification",
      details: error.message,
    });
  }
});

exports.confirmPaymentIntent = functions.https.onRequest(async (req, res) => {
  try {
    const {paymentIntentId, token} = req.body;

    const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
      payment_method_data: {
        type: "card",
        card: {
          token: token,
        },
      },
    });

    res.status(200).send({success: true, paymentIntent});
  } catch (error) {
    console.error("Error confirming payment intent:", error);
    res.status(500).send({error: error.message});
  }
});
