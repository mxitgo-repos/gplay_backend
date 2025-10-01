/* eslint-disable no-undef */
/* eslint-disable max-len */
const admin = require("firebase-admin");
const functions = require("firebase-functions");

const stripe = require("stripe")(functions.config().stripe.secret);
admin.initializeApp();

const {FieldValue, Timestamp} = admin.firestore;

const BATCH_SIZE = 500;
const CONCURRENT_LIMIT = 10;
const LEVEL_CONFIG = {
  level0: {minParticipants: 3, taskIndex: 0},
  level1: {minParticipants: 3, taskIndex: 0},
  level2: {minParticipants: 5, taskIndex: 0},
  level3: {minParticipants: 15, taskIndex: 0, maxTotal: 3},
  level4: {minParticipants: 25, taskIndex: 0, maxTotal: 5, isSubTask: true},
};

exports.getAllUsersAuthInfo = functions.https.onRequest(async (req, res) => {
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

  try {
    const allUsersResult = await admin.auth().listUsers();
    const adminsSnapshot = await admin.firestore().collection("admins").get();
    const adminIds = adminsSnapshot.docs.map((doc) => doc.id);

    const regularUsers = allUsersResult.users.filter((user) => !adminIds.includes(user.uid));

    const usersAuthInfo = regularUsers.map((user) => ({
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      disabled: user.disabled,
      creationTime: user.metadata.creationTime,
      lastSignInTime: user.metadata.lastSignInTime,
      lastRefreshTime: user.metadata.lastRefreshTime,
    }));

    return res.status(200).send({
      success: true,
      users: usersAuthInfo,
      totalUsers: usersAuthInfo.length,
    });
  } catch (error) {
    console.error("Error getting all users auth info:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error getting all users authentication information",
      details: error.message,
    });
  }
});

exports.getUsersAuthInfo = functions.https.onRequest(async (req, res) => {
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

  const {userIds} = req.body;

  if (!userIds || !Array.isArray(userIds)) {
    return res.status(400).send({
      error: "bad-request",
      message: "userIds array is required",
    });
  }

  try {
    const usersAuthInfo = [];
    const batchSize = 100;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const batchPromises = batch.map(async (uid) => {
        try {
          const userRecord = await admin.auth().getUser(uid);
          return {
            uid: userRecord.uid,
            email: userRecord.email,
            emailVerified: userRecord.emailVerified,
            disabled: userRecord.disabled,
            creationTime: userRecord.metadata.creationTime,
            lastSignInTime: userRecord.metadata.lastSignInTime,
            lastRefreshTime: userRecord.metadata.lastRefreshTime,
          };
        } catch (error) {
          console.log(`User ${uid} not found in Auth:`, error.message);
          return null;
        }
      });
      const batchResults = await Promise.all(batchPromises);
      usersAuthInfo.push(...batchResults.filter((user) => user !== null));
    }

    return res.status(200).send({
      success: true,
      users: usersAuthInfo,
      totalFound: usersAuthInfo.length,
      totalRequested: userIds.length,
    });
  } catch (error) {
    console.error("Error getting users auth info:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error getting users authentication information",
      details: error.message,
    });
  }
});


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

  try {
    const users = await admin.auth().listUsers();
    const adminsSnapshot = await admin.firestore().collection("admins").get();

    const adminIds = adminsSnapshot.docs.map((doc) => doc.id);

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    const start = startOfDay.getTime();
    const end = endOfDay.getTime();

    const activeUsers = users.users.filter((user) => {
      const lastLogin = user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime).getTime() : 0;
      const isActive = lastLogin >= start && lastLogin <= end;
      const isAdmin = adminIds.includes(user.uid);

      return isActive && !isAdmin;
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

  const {userId, title, content, notificationType, titleEsp, contentEsp} = req.body;

  if (!userId || !title || !content || !notificationType || !titleEsp || !contentEsp) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, title, content and notificationType of the pust notification user are required",
    });
  }

  const notificationData = {
    title,
    titleEsp,
    content,
    contentEsp,
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

  if (!eventData.isPrivate) {
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
          const userData = doc.data();

          const userGender = userData.gender;
          const eventGenders = eventData.gender;

          const genderMatches = eventGenders.includes("All") || eventGenders.includes(userGender);

          if (eventData.hostRef.id != userRef.id && genderMatches) {
            batch.update(userRef, {
              notifications: admin.firestore.FieldValue.arrayUnion({
                title: "Event Just for You!",
                titleEsp: "¡Evento Solo Para Ti!",
                content: "We found an event that matches your interests. Don’t miss out—check it out now and see if it’s the perfect fit!",
                contentEsp: "Encontramos un evento que coincide con tus intereses. ¡No te lo pierdas, échale un vistazo ahora y mira si es perfecto para ti!",
                notificationType: "1",
                isRead: false,
                date: Timestamp.now(),
                image: eventData.photo,
                eventId: snap.id,
                eventHost: eventData.hostRef.id,
                navigation: "eventdetail",
              }),
            });
          }
        });

        await batch.commit();
        lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
      }

      console.log("Notifications successfully added to user documents.");
    } catch (error) {
      console.error("Error sending notification sendNotificationByInterest:", error);
    }
  }
});

exports.sendNotificationInviteUsers = functions.runWith({memory: "1GB"}).https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {inviteUser, eventName, eventPhoto, eventId, guestIds} = req.body;

  if (!inviteUser || !eventName || !eventPhoto || !eventId || !guestIds || !Array.isArray(guestIds)) {
    return res.status(400).send({
      error: "bad-request",
      message: "The inviteUser, eventName, eventPhoto, eventId and guestIds (array) are required",
    });
  }

  if (guestIds.length === 0) {
    return res.status(400).send({
      error: "bad-request",
      message: "guestIds array cannot be empty",
    });
  }

  const results = [];
  const errors = [];

  for (const guestId of guestIds) {
    try {
      const message = {
        notification: {
          title: "You've Got an Invite!",
          body: `${inviteUser} just invited you to join the event ${eventName}! Ready to RSVP? Accept or decline—it's your call!`,
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

      await admin.messaging().send(message);
      console.log(`Notification successfully sent to the topic: ${guestId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`);

      await admin.firestore().collection("user").doc(guestId).update({
        notifications: FieldValue.arrayUnion({
          title: "You've Got an Invite!",
          titleEsp: "¡Tienes una Invitación!",
          content: `${inviteUser} just invited you to join the event ${eventName}! Ready to RSVP? Accept or decline—it's your call!`,
          contentEsp: `¡${inviteUser} te acaba de invitar a unirte al evento ${eventName}! ¿Listo para confirmar? Acepta o rechaza, ¡tú decides!`,
          notificationType: "2",
          isRead: false,
          date: Timestamp.now(),
          image: eventPhoto,
          eventId: eventId,
          eventHost: "",
          navigation: "myevents",
        }),
      });

      results.push({
        guestId: guestId,
        status: "success",
        message: "Notification sent successfully",
      });
    } catch (error) {
      console.error(`Error sending notification to ${guestId}:`, error);
      errors.push({
        guestId: guestId,
        status: "error",
        message: error.message,
      });
    }
  }

  console.log(`Processed ${results.length} successful notifications and ${errors.length} errors.`);

  if (errors.length === 0) {
    return res.status(200).send({
      message: "All notifications sent successfully",
      successCount: results.length,
      results: results,
    });
  } else if (results.length === 0) {
    return res.status(500).send({
      error: "internal",
      message: "Failed to send all notifications",
      errorCount: errors.length,
      errors: errors,
    });
  } else {
    return res.status(207).send({
      message: "Partially successful",
      successCount: results.length,
      errorCount: errors.length,
      results: results,
      errors: errors,
    });
  }
});

exports.sendNotificationByState = functions.firestore.document("event/{eventId}").onCreate(async (snap, context) => {
  const eventData = snap.data();

  if (!eventData.isPrivate) {
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
          const userData = doc.data();

          const userGender = userData.gender;
          const eventGenders = eventData.gender;

          const genderMatches = eventGenders.includes("All") || eventGenders.includes(userGender);

          if (eventData.hostRef.id != userRef.id && genderMatches) {
            batch.update(userRef, {
              notifications: admin.firestore.FieldValue.arrayUnion({
                title: "New Events Nearby!",
                titleEsp: "¡Nuevos Eventos Cerca!",
                content: "New events just popped up near you! Dive in and see what's happening around town!",
                contentEsp: "¡Acaban de aparecer nuevos eventos cerca de ti! Descubre que está pasando en la ciudad",
                notificationType: "3",
                isRead: false,
                date: Timestamp.now(),
                image: eventData.photo,
                eventId: snap.id,
                eventHost: eventData.hostRef.id,
                navigation: "eventdetail",
              }),
            });
          }
        });

        await batch.commit();
        lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
      }

      console.log("Notifications successfully added to user documents.");
    } catch (error) {
      console.error("Error sending notification sendNotificationByState:", error);
    }
  }
});

exports.sendNotificationEventsReminder = functions.pubsub.schedule("0 12 * * *").onRun(async (context) => {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);

  const endOfTomorrow = new Date(tomorrow);
  endOfTomorrow.setUTCHours(23, 59, 59, 999);

  console.log(`Searching for events tomorrow (${tomorrow.toISOString().slice(0, 10)})`);

  try {
    const snapshot = await admin.firestore().collection("event")
        .where("startDate", ">=", tomorrow)
        .where("startDate", "<=", endOfTomorrow)
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
                titleEsp: "¡Recordatorio de Evento!",
                content: `Your event '${eventData.name}' is coming up soon! Are you ready for it?`,
                contentEsp: `Tu evento '${eventData.name}' se acerca! ¿Estás listo?`,
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
            titleEsp: "Opinión del Evento",
            content: "The event has ended. Share your thoughts by leaving a review for others!",
            contentEsp: "El evento ha terminado. ¡Comparte tus opiniones dejando una reseña!",
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

  if (!eventData.isPrivate) {
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
          const userData = doc.data();

          const userGender = userData.gender;
          const eventGenders = eventData.gender;

          const genderMatches = eventGenders.includes("All") || eventGenders.includes(userGender);

          if (eventData.hostRef.id != userRef.id && genderMatches) {
            batch.update(userRef, {
              notifications: admin.firestore.FieldValue.arrayUnion({
                title: "Last-Minute Events",
                titleEsp: "Eventos de Último Momento",
                content: "Last-minute events have just popped up. Interested in attending one?",
                contentEsp: "Acaban de aparecer eventos de último momento. ¿Te interesa asistir?",
                notificationType: "6",
                isRead: false,
                date: Timestamp.now(),
                image: eventData.photo,
                eventId: snap.id,
                eventHost: eventData.hostRef.id,
                navigation: "eventdetail",
              }),
            });
          }
        });

        await batch.commit();
        lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
      }

      console.log("Notifications successfully added to user documents.");
    } catch (error) {
      console.error("Error sending notification sendNotificationLastMinutes:", error);
    }
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
                titleEsp: "Recordatorio de Evento Favorito",
                content: `The event '${eventData.name}' you favorited is happening in ${daysLeft} days. Are you going to join?`,
                contentEsp: `El evento '${eventData.name}' que marcaste como favorito será en ${daysLeft} días. ¿Asistirás?`,
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
        titleEsp: "Nuevo Mensaje",
        content: `${userName} just sent you a message. Check it out!`,
        contentEsp: `¡${userName} te acaba de enviar un mensaje. Échale un vistazo!`,
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

exports.sendNotificationNewRequest = functions.https.onRequest(async (req, res) => {
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
      title: "New Friend Alert!",
      body: `${userName} wants to be your buddy! Ready to connect? Accept their friend request and start the fun!`,
      image: userPhoto,
    },
    data: {
      notification: "16",
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
        title: "New Friendship Alert",
        titleEsp: "¡Nueva Alerta de Amistad!",
        content: `${userName} wants to be your friend! Accept the request and start chatting right away`,
        contentEsp: `¡${userName} quiere ser tu amigo! Acepta su solicitud y empieza a chatear de inmediato`,
        notificationType: "16",
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
    console.error("Error sending sendNotificationNewRequest notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationNewRequest notification",
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
            titleEsp: "Califica la App",
            content: "We’d love your feedback! Take a moment to rate our app",
            contentEsp: "¡Nos encantaría conocer tu opinión! Tómate un momento para calificar nuestra aplicación",
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
            titleEsp: "Crea un Evento",
            content: `Thinking of creating an event for ${selectedName} interest? Get started now!`,
            contentEsp: `¿Tienes ganas de organizar un evento genial sobre $ {selectedName}? ¡No esperes más! Empieza a crearlo`,
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

// exports.sendNotificationRecurringEvent = functions.pubsub.schedule("0 12 * * 1").onRun(async (context) => {
//   const message = {
//     notification: {
//       title: "Recurring Event Promotion",
//       body: "You marked your event as recurring! Would you like to promote it with paid advertising?",
//       image: "",
//     },
//     data: {
//       notification: "12",
//       information: JSON.stringify({
//         eventHost: "",
//       }),
//       image: "",
//       date: new Date().toISOString(),
//     },
//     android: {
//       notification: {
//         sound: "default",
//         priority: "high",
//         channelId: "high_importance_channel",
//       },
//     },
//     apns: {
//       payload: {
//         aps: {
//           sound: "default",
//         },
//       },
//     },
//     topic: "allUser",
//   };

//   try {
//     const response = await admin.messaging().send(message);
//     console.log(`Notification successfully sent to the topic sendNotificationRecurringEvent: ${response}`);

//     const usersRef = admin.firestore().collection("user");

//     const batchSize = 500;
//     let lastDoc = null;
//     let hasMoreDocuments = true;

//     while (hasMoreDocuments) {
//       let query = usersRef.limit(batchSize);
//       if (lastDoc) {
//         query = query.startAfter(lastDoc);
//       }

//       const usersSnapshot = await query.get();
//       if (usersSnapshot.empty) {
//         hasMoreDocuments = false;
//         break;
//       }

//       const batch = admin.firestore().batch();
//       usersSnapshot.forEach((doc) => {
//         const userRef = doc.ref;
//         batch.update(userRef, {
//           notifications: admin.firestore.FieldValue.arrayUnion({
//             title: "Recurring Event Promotion",
//             content: "You marked your event as recurring! Would you like to promote it with paid advertising?",
//             notificationType: "12",
//             isRead: false,
//             date: Timestamp.now(),
//             image: "",
//             eventHost: "",
//             navigation: "createevent",
//           }),
//         });
//       });

//       await batch.commit();
//       lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];
//     }

//     console.log("Notifications successfully added to user documents.");
//   } catch (error) {
//     console.error(`Error sending notification for event sendNotificationRecurringEvent:`, error);
//   }
// });

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
        titleEsp: "Atención! Tienes una pregunta",
        content: "Someone has a question about your event. Head over to check it out!",
        contentEsp: "Alguien hizo una pregunta sobre tu evento. ¡Entra ahora para responderla!",
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

  const {titleMessage, bodyMessage, imageMessage, urlMessage, titleMessageEsp, bodyMessageEsp} = req.body;

  if (!titleMessage || !bodyMessage || !titleMessageEsp || !bodyMessageEsp) {
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
            titleEsp: titleMessageEsp,
            content: bodyMessage,
            contentEsp: bodyMessageEsp,
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

exports.createPaymentIntentIos = functions.https.onCall(async (data, context) => {
  try {
    const {amount, currency} = data;

    const customer = await stripe.customers.create();

    const ephemeralKey = await stripe.ephemeralKeys.create(
        {customer: customer.id},
        {apiVersion: "2023-10-16"},
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount,
      currency: currency,
      customer: customer.id,
      payment_method_types: ["card"],
    });

    return {success: true, paymentIntent: paymentIntent.client_secret, ephemeralKey: ephemeralKey.secret, customer: customer.id, paymentIntentId: paymentIntent.id};
  } catch (error) {
    console.error("Stripe error:", error);
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

  const {titleMessage, bodyMessage, imageMessage, urlMessage, userId, titleMessageEsp, bodyMessageEsp} = req.body;

  if (!titleMessage || !bodyMessage || !titleMessageEsp || !bodyMessageEsp) {
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
        titleEsp: titleMessageEsp,
        content: bodyMessage,
        contentEsp: bodyMessageEsp,
        notificationType: "15",
        isRead: false,
        date: Timestamp.now(),
        image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
        navigation: "",
        url: urlMessage == undefined && urlMessage == null ? "" : urlMessage,
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

exports.appleCallbackHandler = functions.https.onRequest(async (req, res) => {
  try {
    console.log("Request body:", req.body);

    const redirect = `intent://callback?${new URLSearchParams(
        req.body,
    ).toString()}#Intent;package=com.gplay.app;scheme=signinwithapple;end`;

    console.log("Redirecting to:", redirect);
    res.redirect(307, redirect);
  } catch (error) {
    console.error("Error in Apple callback:", error);
    res.redirect(307, `intent://callback?error=auth_failed#Intent;package=com.gplay.app;scheme=signinwithapple;end`);
  }
});

exports.eventClose = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const {eventId, newStartDate, newEndDate} = body;

  if (eventId === undefined || newStartDate === undefined || newEndDate === undefined) {
    return res.status(400).send({
      error: "bad-request",
      message: "The eventId, newStartDate and newEndDate are required",
    });
  }

  try {
    const startDateUTC = new Date(newStartDate);
    const endDateUTC = new Date(newEndDate);

    const offsetHours = 6; // GMT-6
    const startDate = new Date(startDateUTC.getTime() + (offsetHours * 60 * 60 * 1000));
    const endDate = new Date(endDateUTC.getTime() + (offsetHours * 60 * 60 * 1000));

    const startTimestamp = Timestamp.fromDate(startDate);
    const endTimestamp = Timestamp.fromDate(endDate);

    console.log("Zona horaria configurada: GMT-6");
    console.log("Fecha original recibida:", newStartDate);
    console.log("Fecha ajustada con offset:", startDate.toISOString());
    console.log("Fecha final en Timestamp:", startTimestamp.toDate().toISOString());

    await admin.firestore().collection("event").doc(eventId).update({
      isEnd: true,
      startDate: startTimestamp,
      endDate: endTimestamp,
    });

    return res.status(200).send({message: "Event closed successfully"});
  } catch (error) {
    return res.status(500).send({error: "internal", message: "Error closing event", details: error.message});
  }
});

exports.eventFinish = functions.runWith({timeoutSeconds: 540, memory: "1GB"}).https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch (error) {
    return res.status(400).send({
      error: "bad-request",
      message: "Invalid JSON in request body",
    });
  }

  const requiredFields = [
    "eventId", "participants", "userId", "tokensEvent",
    "isSelling", "usersPaid", "price", "levelsPercentage", "feeOption",
  ];

  const missingFields = requiredFields.filter((field) => body[field] === undefined);
  if (missingFields.length > 0) {
    return res.status(400).send({
      error: "bad-request",
      message: `Missing required fields: ${missingFields.join(", ")}`,
    });
  }

  const {
    eventId, participants, userId, tokensEvent, isSelling,
    usersPaid, price, feeOption,
  } = body;

  if (!Array.isArray(usersPaid) || !Array.isArray(participants)) {
    return res.status(400).send({
      error: "bad-request",
      message: "usersPaid and participants must be arrays",
    });
  }

  const db = admin.firestore();
  let batch = db.batch();
  let batchOperations = 0;

  try {
    const dateFormatted = getFormattedDate();
    const gTokensPercentage = price * (feeOption / 100);
    let referralProcessedCount = 0;

    const processReferralUser = async (paidUserId) => {
      try {
        const userDoc = await db.collection("user").doc(paidUserId).get();

        if (!userDoc.exists) {
          console.log(`User ${paidUserId} does not exist`);
          return 0;
        }

        const userData = userDoc.data();
        const referredBy = userData.referredBy;

        if (!referredBy) return 0;

        const ref1Doc = await db.collection("user").doc(referredBy).get();
        if (!ref1Doc.exists) return 0;

        console.log(`User ${referredBy} receives ${gTokensPercentage} tokens`);

        if (batchOperations >= BATCH_SIZE - 10) {
          await batch.commit();
          batch = db.batch();
          batchOperations = 0;
        }

        const userRef = db.collection("user").doc(referredBy);
        const level1Ref = userRef.collection("level1").doc(paidUserId);
        const earningsRef = userRef.collection("earningsLevel1").doc(dateFormatted);
        const mlmEarningsRef = db.collection("mlmEarnings").doc(dateFormatted);
        const mlmTrackingRef = db.collection("mlmTracking").doc(paidUserId);

        batch.update(userRef, {
          "earningsReferral.level1": FieldValue.increment(gTokensPercentage),
          "earningsReferral.total": FieldValue.increment(gTokensPercentage),
          "gTokens": FieldValue.increment(gTokensPercentage),
          "transactionsReferral": FieldValue.arrayUnion({
            "date": dateFormatted,
            "amount": gTokensPercentage,
            "type": "ticket_purchase",
            "event": eventId,
          }),
        });

        batch.set(level1Ref, {
          "amount": gTokensPercentage,
          "userId": paidUserId,
          "lastMove": FieldValue.serverTimestamp(),
        }, {merge: true});

        batch.set(earningsRef, {
          "earnings": FieldValue.increment(gTokensPercentage),
        }, {merge: true});

        batch.set(mlmEarningsRef, {
          "earnings": FieldValue.increment(gTokensPercentage),
          "dateEarnings": FieldValue.serverTimestamp(),
        }, {merge: true});

        batch.set(mlmTrackingRef, {
          "lastMove": FieldValue.serverTimestamp(),
          "level": 1,
        }, {merge: true});

        batchOperations += 5;
        return gTokensPercentage;
      } catch (error) {
        console.error(`Error processing user ${paidUserId}:`, error.message);
        return 0;
      }
    };

    console.log(`Processing ${usersPaid.length} referral users`);
    const referralResults = await processInChunks(
        usersPaid,
        CONCURRENT_LIMIT,
        processReferralUser,
    );

    referralProcessedCount = referralResults.reduce((sum, amount) => sum + amount, 0);

    if (batchOperations >= BATCH_SIZE - 5) {
      await batch.commit();
      batch = db.batch();
      batchOperations = 0;
    }

    const eventRef = db.collection("event").doc(eventId);
    batch.update(eventRef, {
      isEnd: true,
      isClose: true,
      ticketsTokens: 0,
    });
    batchOperations += 1;

    const gtokensTotal = isSelling ? (tokensEvent + 100) : tokensEvent;
    const userRef = db.collection("user").doc(userId);

    batch.update(userRef, {
      gTokens: FieldValue.increment(gtokensTotal - referralProcessedCount),
      retentionGTokens: FieldValue.increment(isSelling ? -100 : 0),
      badgesCreated: participants.length == 0 ? FieldValue.increment(0) : FieldValue.increment(1),
    });
    batchOperations += 1;

    console.log(`User ${userId} tokens deducted: ${referralProcessedCount}`);

    const participantRefs = participants.map((path) => db.doc(path));

    participantRefs.forEach((ref, index) => {
      if (batchOperations >= BATCH_SIZE - 2) return;

      const otherParticipantRefs = participantRefs.filter((_, i) => i !== index);
      if (otherParticipantRefs.length > 0) {
        batch.update(ref, {
          knownPeopleRef: FieldValue.arrayUnion(...otherParticipantRefs),
        });
        batchOperations += 1;
      }
    });

    await batch.commit();

    const [userDoc, eventDoc] = await Promise.all([
      db.collection("user").doc(userId).get(),
      db.collection("event").doc(eventId).get(),
    ]);

    if (userDoc.exists && eventDoc.exists) {
      const userData = userDoc.data();
      const eventData = eventDoc.data();
      const participantCount = eventData.participantsRef.length || 0;

      await updateAmbassadorTasks(userId, userData, participantCount);
    }

    console.log(`Event ${eventId} finished successfully`);
    return res.status(200).send({
      message: "Event finished successfully",
      referralProcessed: referralProcessedCount,
    });
  } catch (error) {
    console.error("Error in eventFinish:", error);

    try {
      if (batchOperations > 0) {
        console.error("Batch operations were pending, manual cleanup might be needed");
      }
    } catch (rollbackError) {
      console.error("Rollback error:", rollbackError);
    }

    return res.status(500).send({
      error: "internal",
      message: "Error finishing event",
      details: process.env.NODE_ENV === "development" ? error.message : "Internal server error",
    });
  }
});

exports.validatePhoneNumber = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const {phoneNumber} = body;

  if (phoneNumber === undefined) {
    return res.status(400).send({
      error: "bad-request",
      message: "The phoneNumber is required",
    });
  }

  try {
    const querySnapshot = await admin.firestore()
        .collection("user")
        .where("kyc", "==", true)
        .where("phoneNumber", "==", phoneNumber)
        .limit(1)
        .get();

    const exists = !querySnapshot.empty;

    return res.status(200).send({exists});
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error validating phone number",
      details: error.message,
    });
  }
});

exports.getUserData = functions.runWith({memory: "1GB"}).https.onCall(async (data, context) => {
  const documentId = data.documentId;

  console.log("Document ID:", documentId);
  try {
    const userDoc = await admin.firestore().collection("user")
        .doc(documentId)
        .get();

    if (!userDoc.exists) {
      throw new functions.https.HttpsError(
          "not-found",
          "User document not found",
      );
    }

    const userData = userDoc.data();

    const sanitizedData = JSON.parse(JSON.stringify(userData, (key, value) => {
      if (value && typeof value === "object" && value.constructor.name === "Timestamp") {
        return value.toDate().toISOString();
      }
      return value;
    }));

    return sanitizedData;
  } catch (error) {
    console.error("Error retrieving user document:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Error processing request",
    );
  }
});

exports.updateBanking = functions.firestore.document("user/{userId}").onUpdate(async (change, context) => {
  const beforeData = change.before.data();
  const afterData = change.after.data();

  if (beforeData.referralCount === afterData.referralCount) {
    console.log("referralCount did not change, ranking update skipped");
    return null;
  }

  console.log(`referralCount changed from ${beforeData.referralCount} to ${afterData.referralCount}`);

  const pageSize = 500;
  let lastDoc = null;
  let hasMore = true;
  let rank = 1;

  while (hasMore) {
    let query = admin.firestore().collection("user")
        .orderBy("referralCount", "desc")
        .limit(pageSize);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = admin.firestore().batch();
    snapshot.docs.forEach((doc) => {
      const userRef = admin.firestore().collection("user").doc(doc.id);
      batch.update(userRef, {
        rank: rank++,
      });
    });

    await batch.commit();
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    hasMore = snapshot.size === pageSize;
  }

  console.log("Referral ranking updated after referralCount change");
  return null;
});

exports.processReferral = functions.https.onCall(async (data, context) => {
  try {
    const details = data;

    if (details.referredBy === "") {
      return {success: true, message: "There is no referral to process"};
    }

    const ref1 = details.referredBy;
    const now = new Date();
    const formatted = now.toISOString().split("T")[0];

    const ref1Doc = await admin.firestore().collection("user").doc(ref1).get();

    if (!ref1Doc.exists) {
      return {success: false, message: "The referral does not exist"};
    }

    const batch1 = admin.firestore().batch();

    batch1.update(admin.firestore().collection("user").doc(details.referredBy), {
      "level1": admin.firestore.FieldValue.arrayUnion(details.id),
      "referralCount": admin.firestore.FieldValue.increment(1),
    });

    batch1.set(
        admin.firestore().collection("user").doc(details.referredBy).collection("level1").doc(details.id),
        {
          "amount": 0,
          "lastMove": null,
          "userId": details.id,
        },
    );

    batch1.set(
        admin.firestore().collection("user").doc(details.referredBy).collection("earningsLevel1").doc(formatted),
        {
          "earnings": admin.firestore.FieldValue.increment(0),
          "referralCount": admin.firestore.FieldValue.increment(1),
        },
        {merge: true},
    );

    batch1.set(
        admin.firestore().collection("mlmEarnings").doc(formatted),
        {
          "earnings": admin.firestore.FieldValue.increment(0),
          "dateEarnings": admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
    );

    batch1.set(
        admin.firestore().collection("mlmTracking").doc(details.id),
        {
          "lastMove": null,
          "level": 1,
          "mlmTrackingCreated": admin.firestore.FieldValue.serverTimestamp(),
        },
        {merge: true},
    );

    await batch1.commit();

    const ref2 = ref1Doc.data().referredBy;
    if (ref2 && ref2 !== "") {
      const batch2 = admin.firestore().batch();

      batch2.update(admin.firestore().collection("user").doc(ref2), {
        "level2": admin.firestore.FieldValue.arrayUnion(details.id),
        "referralCount": admin.firestore.FieldValue.increment(1),
      });

      batch2.set(
          admin.firestore().collection("user").doc(ref2).collection("level2").doc(details.id),
          {
            "amount": 0,
            "lastMove": null,
            "userId": details.id,
          },
      );

      batch2.set(
          admin.firestore().collection("user").doc(ref2).collection("earningsLevel2").doc(formatted),
          {
            "earnings": admin.firestore.FieldValue.increment(0),
            "referralCount": admin.firestore.FieldValue.increment(1),
          },
          {merge: true},
      );

      batch2.set(
          admin.firestore().collection("mlmEarnings").doc(formatted),
          {
            "earnings": admin.firestore.FieldValue.increment(0),
            "dateEarnings": admin.firestore.FieldValue.serverTimestamp(),
          },
          {merge: true},
      );

      batch2.set(
          admin.firestore().collection("mlmTracking").doc(details.id),
          {
            "lastMove": null,
            "level": 2,
            "mlmTrackingCreated": admin.firestore.FieldValue.serverTimestamp(),
          },
          {merge: true},
      );

      await batch2.commit();

      const ref2Doc = await admin.firestore().collection("user").doc(ref2).get();
      const ref3 = ref2Doc.data().referredBy;

      if (ref3 && ref3 !== "") {
        const batch3 = admin.firestore().batch();

        batch3.update(admin.firestore().collection("user").doc(ref3), {
          "level3": admin.firestore.FieldValue.arrayUnion(details.id),
          "referralCount": admin.firestore.FieldValue.increment(1),
        });

        batch3.set(
            admin.firestore().collection("user").doc(ref3).collection("level3").doc(details.id),
            {
              "amount": 0,
              "lastMove": null,
              "userId": details.id,
            },
        );

        batch3.set(
            admin.firestore().collection("user").doc(ref3).collection("earningsLevel3").doc(formatted),
            {
              "earnings": admin.firestore.FieldValue.increment(0),
              "referralCount": admin.firestore.FieldValue.increment(1),
            },
            {merge: true},
        );

        batch3.set(
            admin.firestore().collection("mlmEarnings").doc(formatted),
            {
              "earnings": admin.firestore.FieldValue.increment(0),
              "dateEarnings": admin.firestore.FieldValue.serverTimestamp(),
            },
            {merge: true},
        );

        batch3.set(
            admin.firestore().collection("mlmTracking").doc(details.id),
            {
              "lastMove": null,
              "level": 3,
              "mlmTrackingCreated": admin.firestore.FieldValue.serverTimestamp(),
            },
            {merge: true},
        );

        await batch3.commit();

        const ref3Doc = await admin.firestore().collection("user").doc(ref3).get();
        const ref4 = ref3Doc.data().referredBy;

        if (ref4 && ref4 !== "") {
          const batch4 = admin.firestore().batch();

          batch4.update(admin.firestore().collection("user").doc(ref4), {
            "level4": admin.firestore.FieldValue.arrayUnion(details.id),
            "referralCount": admin.firestore.FieldValue.increment(1),
          });

          batch4.set(
              admin.firestore().collection("user").doc(ref4).collection("level4").doc(details.id),
              {
                "amount": 0,
                "lastMove": null,
                "userId": details.id,
              },
          );

          batch4.set(
              admin.firestore().collection("user").doc(ref4).collection("earningsLevel4").doc(formatted),
              {
                "earnings": admin.firestore.FieldValue.increment(0),
                "referralCount": admin.firestore.FieldValue.increment(1),
              },
              {merge: true},
          );

          batch4.set(
              admin.firestore().collection("mlmEarnings").doc(formatted),
              {
                "earnings": admin.firestore.FieldValue.increment(0),
                "dateEarnings": admin.firestore.FieldValue.serverTimestamp(),
              },
              {merge: true},
          );

          batch4.set(
              admin.firestore().collection("mlmTracking").doc(details.id),
              {
                "lastMove": null,
                "level": 4,
                "mlmTrackingCreated": admin.firestore.FieldValue.serverTimestamp(),
              },
              {merge: true},
          );

          await batch4.commit();
        }
      }
    }

    return {success: true, message: "Referrals processed successfully"};
  } catch (error) {
    console.error("Error processing referrals:", error);
    return {success: false, message: "Error: " + error.message};
  }
});

exports.updateAmbassadorRankings = functions.firestore.document("user/{userId}").onUpdate(async (change, context) => {
  const beforeData = change.before.data();
  const afterData = change.after.data();

  if (beforeData.referralCount === afterData.referralCount) {
    console.log("referralCount did not change, ranking update skipped");
    return null;
  }

  console.log(`referralCount changed from ${beforeData.referralCount} to ${afterData.referralCount}`);

  const levels = ["level1", "level2", "level3", "level4"];

  for (const level of levels) {
    await updateRankingForLevel(level);
  }

  console.log("Ambassador rankings updated after referralCount change");
  return null;
});

exports.updateAmbassadorRankingsManual = functions.https.onCall(async (data, context) => {
  console.log("Starting manual update of ambassador rankings");

  const levels = ["level1", "level2", "level3", "level4"];

  for (const level of levels) {
    await updateRankingForLevel(level);
  }

  console.log("Manual update of ambassador rankings completed");

  return {success: true, message: "Rankings updated correctly"};
});

exports.sendNotificationSendGift = functions.https.onRequest(async (req, res) => {
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

  const {titleMessage, bodyMessage, imageMessage, urlMessage, userId, titleMessageEsp, bodyMessageEsp} = req.body;

  if (!titleMessage || !bodyMessage || !titleMessageEsp || !bodyMessageEsp) {
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
      notification: "17",
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
    console.log("Notification successfully sent to the topic: sendNotificationSendGift");

    await admin.firestore().collection("user").doc(userId).update({
      notifications: FieldValue.arrayUnion({
        title: titleMessage,
        titleEsp: titleMessageEsp,
        content: bodyMessage,
        contentEsp: bodyMessageEsp,
        notificationType: "17",
        isRead: false,
        date: Timestamp.now(),
        image: imageMessage == undefined && imageMessage == null ? "" : imageMessage,
        navigation: "",
        url: urlMessage == undefined && urlMessage == null ? "" : urlMessage,
      }),
    });

    console.log("Notifications successfully added to user documents.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationSendGift notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationSendGift notification",
      details: error.message,
    });
  }
});

exports.countAmbassadorUsers = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const {userId} = body;

  if (userId === undefined) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId is required",
    });
  }

  try {
    const userDoc = await admin.firestore().collection("user").doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).send({
        error: "not-found",
        message: `User with ID ${userId} not found`,
      });
    }

    const userData = userDoc.data();

    const userIdsList = userData.level1;

    if (!Array.isArray(userIdsList) || userIdsList.length === 0) {
      return res.status(200).send({
        message: "No user IDs to process",
        count: 0,
        totalProcessed: 0,
        totalUsers: 0,
        completed: true,
      });
    }

    let count = 0;
    let totalProcessed = 0;
    const maxCount = 10;
    const pageSize = 25;
    let currentIndex = 0;

    console.log(`Starting ambassador count process for user ${userId} with ${userIdsList.length} users to check`);

    while (currentIndex < userIdsList.length && count < maxCount) {
      try {
        const endIndex = Math.min(currentIndex + pageSize, userIdsList.length);
        const currentBatch = userIdsList.slice(currentIndex, endIndex);

        console.log(`Processing batch ${Math.floor(currentIndex / pageSize) + 1}: users ${currentIndex + 1} to ${endIndex}`);

        for (const id of currentBatch) {
          try {
            const userToCheckDoc = await admin.firestore().collection("user").doc(id).get();

            if (userToCheckDoc.exists) {
              const userToCheckData = userToCheckDoc.data();
              const currentLevelAmbasador = userToCheckData.currentLevelAmbasador || "";

              if (currentLevelAmbasador.trim() !== "") {
                count++;
                console.log(`User ${id} has ambassador level: "${currentLevelAmbasador}" (${count}/${maxCount})`);

                if (count >= maxCount) {
                  console.log(`Reached maximum count of ${maxCount} users with ambassador level`);
                  break;
                }
              }
            } else {
              console.log(`User ${id} does not exist, skipping`);
            }

            totalProcessed++;
          } catch (userError) {
            console.error(`Error processing user ${id}:`, userError.message);
            totalProcessed++;
            continue;
          }
        }

        if (count >= maxCount) {
          break;
        }

        currentIndex = endIndex;

        if (currentIndex < userIdsList.length && count < maxCount) {
          await new Promise((resolve) =>{
            setTimeout(resolve, 50);
          });
        }
      } catch (batchError) {
        console.error(`Error processing batch starting at index ${currentIndex}:`, batchError.message);

        currentIndex = Math.min(currentIndex + pageSize, userIdsList.length);
        continue;
      }
    }

    console.log(`Process completed for user ${userId}: Found ${count} users with ambassador level out of ${totalProcessed} processed`);

    const updateSubTasksAmbassador = userData.subTasksAmbassador;

    if (updateSubTasksAmbassador[1]["total"] != count) {
      if (updateSubTasksAmbassador[1]["readyClaim"] == false && updateSubTasksAmbassador[1]["total"] < 10) {
        if (count >= 10) {
          updateSubTasksAmbassador[1] = {...updateSubTasksAmbassador[1], "readyClaim": true, "isClaimed": true, "lastClaimed": userData.serverDate, "total": count};

          await admin.firestore().collection("user").doc(userId).update({
            subTasksAmbassador: updateSubTasksAmbassador,
          });
        } else {
          updateSubTasksAmbassador[1] = {...updateSubTasksAmbassador[1], "total": count};

          await admin.firestore().collection("user").doc(userId).update({
            subTasksAmbassador: updateSubTasksAmbassador,
          });
        }
      }
    }

    return res.status(200).send({
      message: `Successfully counted ambassador users for user ${userId}`,
      count: count,
    });
  } catch (error) {
    console.error(`Error in countAmbassadorUsers for user ${userId}:`, error.message);
    return res.status(500).send({
      error: "internal",
      message: "Error counting ambassador users",
      userId: userId,
      details: error.message,
    });
  }
});

/**
 * Actualiza el ranking de embajadores para un nivel específico
 * @param {string} level - El nivel de embajador (level1, level2, level3, level4)
 * @return {Promise<void>} - Promesa que se resuelve cuando se completa la actualización
 */
async function updateRankingForLevel(level) {
  console.log(`Updating ranking for ${level}`);
  const pageSize = 500;
  let lastDoc = null;
  let hasMore = true;
  let rank = 1;

  while (hasMore) {
    let query = admin.firestore().collection("user")
        .where("currentLevelAmbasador", "==", level)
        .orderBy("referralCount", "desc")
        .limit(pageSize);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) break;

    const batch = admin.firestore().batch();
    snapshot.docs.forEach((doc) => {
      const userRef = admin.firestore().collection("user").doc(doc.id);
      batch.update(userRef, {
        rankAmbasador: rank++,
      });
    });

    await batch.commit();
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    hasMore = snapshot.size === pageSize;
  }

  console.log(`Ranking updated for level ${level}`);
}

/**
 * Updates ambassador tasks based on participant count and user level
 * @param {string} userId - The user ID to update tasks for
 * @param {Object} userData - The user data containing current level and tasks
 * @param {number} participantCount - Number of participants in the event
 * @return {Promise<void>} Promise that resolves when tasks are updated
 */
async function updateAmbassadorTasks(userId, userData, participantCount) {
  const currentLevel = userData.currentLevelAmbasador;
  const config = LEVEL_CONFIG[currentLevel];

  if (!config) return;

  const updates = {};

  if (config.isSubTask && userData.subTasksAmbassador.length > 0) {
    const task = userData.subTasksAmbassador[0];
    if (!task.readyClaim && task.total < config.maxTotal && participantCount >= config.minParticipants) {
      const newTotal = task.total + 1;

      const isMaxReached = newTotal >= config.maxTotal;

      updates.subTasksAmbassador = [...userData.subTasksAmbassador];
      updates.subTasksAmbassador[0] = {
        ...task,
        total: newTotal,
        readyClaim: isMaxReached,
        isClaimed: isMaxReached,
      };
    }
  } else if (userData.tasksAmbassador.length > 0) {
    const task = userData.tasksAmbassador[0];

    if (!task.readyClaim) {
      if (["level0", "level1", "level2"].includes(currentLevel) && participantCount >= config.minParticipants) {
        updates.tasksAmbassador = [...userData.tasksAmbassador];
        updates.tasksAmbassador[0] = {
          ...task,
          readyClaim: true,
          total: participantCount,
        };
      } else if (currentLevel === "level3" && task.total < config.maxTotal && participantCount >= config.minParticipants) {
        const newTotal = task.total + 1;
        updates.tasksAmbassador = [...userData.tasksAmbassador];
        updates.tasksAmbassador[0] = {
          ...task,
          total: newTotal,
          readyClaim: newTotal >= config.maxTotal,
        };
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    await admin.firestore().collection("user").doc(userId).update(updates);
  }
}

/**
 * Processes an array in chunks to avoid overwhelming the system with concurrent operations
 * @param {Array} array - The array to process
 * @param {number} chunkSize - Size of each chunk to process concurrently
 * @param {Function} processor - Function to process each item in the array
 * @return {Promise<Array>} Promise that resolves to array of processed results
 */
async function processInChunks(array, chunkSize, processor) {
  const results = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    const chunk = array.slice(i, i + chunkSize);
    console.log(chunk);
    console.log("chunk");
    const chunkResults = await Promise.all(chunk.map(processor));
    results.push(...chunkResults);
    console.log(results);
    console.log("results");
  }
  return results;
}

/**
 * Gets current date formatted as YYYY-MM-DD string
 * @return {string} Formatted date string in YYYY-MM-DD format
 */
function getFormattedDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
