/* eslint-disable no-undef */
/* eslint-disable max-len */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();

exports.checkEmail = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const email = req.body.email;

  try {
    await admin.auth().getUserByEmail(email);
    return res.status(200).send({exists: true});
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

    const count = activeUsers.length;

    return res.status(200).send({count});
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error getting users",
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
  } catch (error) {
    console.error("Error sending notification sendNotificationByState:", error);
  }
});

exports.sendNotificationEventsReminder = functions.pubsub.schedule("0 0 * * *").onRun(async (context) => {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(today.getUTCDate() + 1);

  const startOfTomorrow = new Date(tomorrow);
  const endOfTomorrow = new Date(tomorrow);
  endOfTomorrow.setUTCHours(23, 59, 59, 999);

  console.log(`Searching for events of the day: ${tomorrow.toISOString().slice(0, 10)}`);

  try {
    const snapshot = await db.collection("event")
        .where("startDate", ">=", startOfTomorrow)
        .where("startDate", "<=", endOfTomorrow)
        .get();

    if (snapshot.empty) {
      console.log("No events found for tomorrow");
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
        console.log(`Notification sent for the event ${eventId}: ${response}`);
      } catch (error) {
        console.error(`Error sending notification for event ${eventId}:`, error);
      }
    });
  } catch (error) {
    console.error("Error getting events:", error);
  }

  return null;
});

exports.putNotificationUser = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId, title, content, image, eventId, eventHost, navigation, notificationType, date} = req.body;

  if (!userId || !title || !content || !image || !eventHost || !navigation || !notificationType) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, title, content, image, eventHost, navigation and notificationType of the pust notification user are required",
    });
  }

  const notificationData = {
    title,
    content,
    image,
    eventId,
    eventHost,
    navigation,
    notificationType,
    "isRead": false,
    "date": date,
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
