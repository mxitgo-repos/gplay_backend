/* eslint-disable no-undef */
/* eslint-disable max-len */
const admin = require("firebase-admin");
const functions = require("firebase-functions");

const stripe = require("stripe")(functions.config().stripe.secret);
admin.initializeApp();

const {FieldValue, Timestamp} = admin.firestore;

const BATCH_SIZE = 500;
// const CONCURRENT_LIMIT = 10;
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

  const {email, userId} = req.body;

  if (!email) {
    return res.status(400).send({
      error: "bad-request",
      message: "The email is required",
    });
  }

  try {
    let existsInAuth = false;
    let authMethods = [];
    let authUserId = null;

    // Check in Firebase Auth
    try {
      const userRecord = await admin.auth().getUserByEmail(email);
      authUserId = userRecord.uid;
      existsInAuth = true;
      authMethods = userRecord.providerData.map((provider) => provider.providerId);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }
    }

    // If exists in Auth and it's the same user, skip Auth validation
    if (existsInAuth && userId && authUserId === userId) {
      existsInAuth = false;
    }

    // Check in Firestore with kyc = true, excluding the current user
    const querySnapshot = await admin.firestore()
        .collection("user")
        .where("kyc", "==", true)
        .where("email", "==", email)
        .get();

    // Filter out the current user from Firestore results
    const existsInFirestore = querySnapshot.docs.some((doc) => {
      return !userId || doc.id !== userId;
    });

    // If exists in either Auth or Firestore (excluding current user), email is taken
    if (existsInAuth || existsInFirestore) {
      return res.status(200).send({
        exists: true,
        existsInAuth: existsInAuth,
        existsInFirestore: existsInFirestore,
        methods: authMethods,
      });
    }

    // Email is available
    return res.status(200).send({
      exists: false,
      existsInAuth: false,
      existsInFirestore: false,
    });
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error checking email",
      details: error.message,
    });
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
    const {startDate, endDate} = req.body;

    let startOfDay;
    let endOfDay;

    if (startDate && endDate) {
      startOfDay = new Date(startDate);
      endOfDay = new Date(endDate);
    } else {
      const now = new Date();
      startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);
    }

    if (isNaN(startOfDay.getTime()) || isNaN(endOfDay.getTime())) {
      return res.status(400).send({
        error: "invalid_dates",
        message: "Invalid date format",
      });
    }

    console.log(`Getting users with lastActivity between ${startOfDay.toISOString()} and ${endOfDay.toISOString()}`);

    const adminsSnapshot = await admin.firestore().collection("admins").get();
    const adminIds = adminsSnapshot.docs.map((doc) => doc.id);

    const usersSnapshot = await admin
        .firestore()
        .collection("user")
        .where("lastActivity", ">=", admin.firestore.Timestamp.fromDate(startOfDay))
        .where("lastActivity", "<=", admin.firestore.Timestamp.fromDate(endOfDay))
        .get();

    const activeUsers = usersSnapshot.docs
        .filter((doc) => !adminIds.includes(doc.id))
        .map((doc) => ({
          uid: doc.id,
          ...doc.data(),
        }));

    return res.status(200).send({
      activeUsers,
      dateRange: {
        start: startOfDay.toISOString(),
        end: endOfDay.toISOString(),
      },
    });
  } catch (error) {
    console.error("Error getting users:", error);
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

  const {userId, title, content, notificationType, titleMessageEsp, bodyMessageEsp} = req.body;

  if (!userId || !title || !content || !notificationType || !titleMessageEsp || !bodyMessageEsp) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, title, content and notificationType of the pust notification user are required",
    });
  }

  const notificationData = {
    title,
    titleEsp: titleMessageEsp,
    content,
    contentEsp: bodyMessageEsp,
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

  if (!eventData.isPrivate && !eventData.adult) {
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

  if (!eventData.isPrivate && !eventData.adult) {
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

  if (!eventData.isPrivate && !eventData.adult) {
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
        contentEsp: `${userName} te acaba de enviar un mensaje. ¡Échale un vistazo!`,
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
    const data = doc.data();
    namesList.push({
      name: data.name,
      name_esp: data.name_esp,
    });
  });

  const randomIndex = Math.floor(Math.random() * namesList.length);
  const selectedName = namesList[randomIndex];

  const message = {
    notification: {
      title: "Create an Event",
      body: `Thinking of creating an event for ${selectedName.name} interest? Get started now!`,
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
            content: `Thinking of creating an event for ${selectedName.name} interest? Get started now!`,
            contentEsp: `¿Tienes ganas de organizar un evento genial sobre ${selectedName.name_esp}? ¡No esperes más! Empieza a crearlo`,
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
    console.log("Transfer created:", transfer);
    return {transferId: transfer.id};
  } catch (error) {
    console.log("Transfer error:", error);
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

  // const {
  //   eventId, participants, userId, isSelling,
  //   usersPaid,
  // } = body;

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
      // referralProcessed: referralProcessedCount,
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
  const {phoneNumber, userId} = body;

  if (phoneNumber === undefined) {
    return res.status(400).send({
      error: "bad-request",
      message: "The phoneNumber is required",
    });
  }

  try {
    let existsInAuth = false;
    let authUserId = null;

    // Check in Firebase Auth
    try {
      const userRecord = await admin.auth().getUserByPhoneNumber(phoneNumber);
      authUserId = userRecord.uid;
      existsInAuth = true;
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        throw error;
      }
    }

    // If exists in Auth and it's the same user, skip Auth validation
    if (existsInAuth && userId && authUserId === userId) {
      existsInAuth = false;
    }

    // Check in Firestore with kyc = true, excluding the current user
    const querySnapshot = await admin.firestore()
        .collection("user")
        .where("kyc", "==", true)
        .where("phoneNumber", "==", phoneNumber)
        .get();

    // Filter out the current user from Firestore results
    const existsInFirestore = querySnapshot.docs.some((doc) => {
      return !userId || doc.id !== userId;
    });

    // If exists in either Auth or Firestore (excluding current user), phone number is taken
    if (existsInAuth || existsInFirestore) {
      return res.status(200).send({
        exists: true,
        existsInAuth: existsInAuth,
        existsInFirestore: existsInFirestore,
      });
    }

    // Phone number is available
    return res.status(200).send({
      exists: false,
      existsInAuth: false,
      existsInFirestore: false,
    });
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

exports.countAmbassadorUsers = functions.runWith({memory: "1GB"}).https.onRequest(async (req, res) => {
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

exports.replenishFreeChats = functions.pubsub.schedule("0 0 * * *").onRun(async () => {
  console.log("Starting replenishFreeChats function");

  try {
    const usersRef = admin.firestore().collection("user");
    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;
    let totalProcessed = 0;
    let totalUpdated = 0;

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
      let batchUpdateCount = 0;

      usersSnapshot.forEach((doc) => {
        const userData = doc.data();
        const currentFreeChats = userData?.pack?.chats?.free || 0;
        const currentPaidChats = userData?.pack?.chats?.paid || 0;
        const isPremium = userData?.isPremium;

        // Skip users with undefined/null isPremium
        if (isPremium === null || isPremium === undefined) {
          return;
        }

        if (isPremium === true) {
          // Premium users: ensure total is 20
          const currentTotal = currentFreeChats + currentPaidChats;
          if (currentTotal < 20) {
            const chatsToAdd = 20 - currentTotal;
            const newPaidChats = currentPaidChats + chatsToAdd;
            const newTotal = currentFreeChats + newPaidChats;

            batch.update(doc.ref, {
              "pack.chats.paid": newPaidChats,
              "pack.chats.total": newTotal,
            });
            batchUpdateCount++;
          }
        } else {
          // Non-premium users: replenish free chats to 5
          if (currentFreeChats < 5) {
            const newFreeChats = 5;
            const newTotal = newFreeChats + currentPaidChats;

            batch.update(doc.ref, {
              "pack.chats.free": newFreeChats,
              "pack.chats.total": newTotal,
            });
            batchUpdateCount++;
          }
        }
      });

      if (batchUpdateCount > 0) {
        await batch.commit();
        totalUpdated += batchUpdateCount;
        console.log(`Batch committed: ${batchUpdateCount} users updated`);
      }

      totalProcessed += usersSnapshot.size;
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];

      console.log(`Processed ${totalProcessed} users so far, updated ${totalUpdated} users`);
    }

    console.log(`Replenish free chats completed. Total processed: ${totalProcessed}, Total updated: ${totalUpdated}`);
    return null;
  } catch (error) {
    console.error("Error in replenishFreeChats:", error);
    throw error;
  }
});

exports.sendNotificationProfileVerification = functions.pubsub.schedule("0 12 * * 1").onRun(async () => {
  console.log("Starting sendNotificationProfileVerification function");

  try {
    const usersRef = admin.firestore().collection("user").where("kyc", "==", false);
    const batchSize = 500;
    let lastDoc = null;
    let hasMoreDocuments = true;
    let totalProcessed = 0;
    let totalNotified = 0;

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
      let batchNotificationCount = 0;

      usersSnapshot.forEach((doc) => {
        const userId = doc.id;

        batch.update(doc.ref, {
          notifications: admin.firestore.FieldValue.arrayUnion({
            title: "Profile Verification",
            titleEsp: "Verificación de Perfil",
            content: "Get verified! Certify your profile for added trust.",
            contentEsp: "¡Verifica tu perfil! Certifica tu perfil para obtener mayor confianza.",
            notificationType: "19",
            isRead: false,
            date: Timestamp.now(),
            image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fkyc_1.png?alt=media&token=f316b428-a344-4746-b135-e2196a815855",
            eventId: "",
            eventHost: "",
            navigation: "kycPhone",
          }),
        });
        batchNotificationCount++;

        const message = {
          notification: {
            title: "Profile Verification",
            body: "Get verified! Certify your profile for added trust.",
          },
          data: {
            notification: "19",
            image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fkyc_1.png?alt=media&token=f316b428-a344-4746-b135-e2196a815855",
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

        admin.messaging().send(message)
            .then(() => {
              console.log(`FCM notification sent to user: ${userId}`);
            })
            .catch((error) => {
              console.error(`Error sending FCM to user ${userId}:`, error);
            });
      });

      await batch.commit();
      totalNotified += batchNotificationCount;
      totalProcessed += usersSnapshot.size;
      lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];

      console.log(`Processed ${totalProcessed} users so far, notified ${totalNotified} users`);
    }

    console.log(`Profile verification notifications completed. Total processed: ${totalProcessed}, Total notified: ${totalNotified}`);
    return null;
  } catch (error) {
    console.error("Error in sendNotificationProfileVerification:", error);
    throw error;
  }
});

exports.sendNotificationProfileVerificationComplete = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId} = req.body;

  if (!userId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId is required",
    });
  }

  const message = {
    notification: {
      title: "Profile Verification Complete",
      body: "Your profile is now verified! Enjoy more trust and better connections.",
    },
    data: {
      notification: "20",
      image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fkyc_1.png?alt=media&token=f316b428-a344-4746-b135-e2196a815855",
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
        title: "Profile Verification Complete",
        titleEsp: "Verificación de Perfil Completa",
        content: "Your profile is now verified! Enjoy more trust and better connections.",
        contentEsp: "¡Tu perfil ahora está verificado! Disfruta de mayor confianza y mejores conexiones.",
        notificationType: "20",
        isRead: false,
        date: Timestamp.now(),
        image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fkyc_1.png?alt=media&token=f316b428-a344-4746-b135-e2196a815855",
        eventId: "",
        eventHost: "",
        navigation: "",
      }),
    });

    console.log("Notification successfully added to user document.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationProfileVerificationComplete notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationProfileVerificationComplete notification",
      details: error.message,
    });
  }
});

// exports.sendNotificationUpgradeToPremium = functions.pubsub.schedule("0 12 * * 1").onRun(async () => {
//   console.log("Starting sendNotificationUpgradeToPremium function");

//   try {
//     const usersRef = admin.firestore().collection("user").where("isPremium", "==", false);
//     const batchSize = 500;
//     let lastDoc = null;
//     let hasMoreDocuments = true;
//     let totalProcessed = 0;
//     let totalNotified = 0;

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
//       let batchNotificationCount = 0;

//       usersSnapshot.forEach((doc) => {
//         const userId = doc.id;

//         batch.update(doc.ref, {
//           notifications: admin.firestore.FieldValue.arrayUnion({
//             title: "Upgrade to Premium",
//             titleEsp: "Actualiza a Premium",
//             content: "Unlock premium features by upgrading now",
//             contentEsp: "Desbloquea funciones premium actualizando ahora",
//             notificationType: "22",
//             isRead: false,
//             date: Timestamp.now(),
//             image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2FG-Play.jpg?alt=media&token=a3479901-e2c5-448e-9096-f652f058c0af",
//             eventId: "",
//             eventHost: "",
//             navigation: "storegplay",
//           }),
//         });
//         batchNotificationCount++;

//         const message = {
//           notification: {
//             title: "Upgrade to Premium",
//             body: "Unlock premium features by upgrading now",
//           },
//           data: {
//             notification: "22",
//             image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2FG-Play.jpg?alt=media&token=a3479901-e2c5-448e-9096-f652f058c0af",
//             date: new Date().toISOString(),
//           },
//           android: {
//             notification: {
//               sound: "default",
//               priority: "high",
//               channelId: "high_importance_channel",
//             },
//           },
//           apns: {
//             payload: {
//               aps: {
//                 sound: "default",
//               },
//             },
//           },
//           topic: `${userId.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
//         };

//         admin.messaging().send(message)
//             .then(() => {
//               console.log(`FCM notification sent to user: ${userId}`);
//             })
//             .catch((error) => {
//               console.error(`Error sending FCM to user ${userId}:`, error);
//             });
//       });

//       await batch.commit();
//       totalNotified += batchNotificationCount;
//       totalProcessed += usersSnapshot.size;
//       lastDoc = usersSnapshot.docs[usersSnapshot.docs.length - 1];

//       console.log(`Processed ${totalProcessed} users so far, notified ${totalNotified} users`);
//     }

//     console.log(`Upgrade to premium notifications completed. Total processed: ${totalProcessed}, Total notified: ${totalNotified}`);
//     return null;
//   } catch (error) {
//     console.error("Error in sendNotificationUpgradeToPremium:", error);
//     throw error;
//   }
// });

exports.sendNotificationPaymentSuccessful = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId} = req.body;

  if (!userId) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId is required",
    });
  }

  const message = {
    notification: {
      title: "Payment Successful",
      body: "Your payment was successful! Enjoy your premium features",
    },
    data: {
      notification: "21",
      image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fstore_AI.png?alt=media&token=290a4469-340d-4d26-a54d-115d1ec8a077",
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
        title: "Payment Successful",
        titleEsp: "Pago Exitoso",
        content: "Your payment was successful! Enjoy your premium features",
        contentEsp: "¡Tu pago fue exitoso! Disfruta de tus funciones premium",
        notificationType: "21",
        isRead: false,
        date: Timestamp.now(),
        image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fstore_AI.png?alt=media&token=290a4469-340d-4d26-a54d-115d1ec8a077",
        eventId: "",
        eventHost: "",
        navigation: "storegplay",
      }),
    });

    console.log("Notification successfully added to user document.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationPaymentSuccessful notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationPaymentSuccessful notification",
      details: error.message,
    });
  }
});

exports.sendNotificationRewardEarned = functions.https.onRequest(async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const {userId, reward, taskName} = req.body;

  if (!userId || !reward || !taskName) {
    return res.status(400).send({
      error: "bad-request",
      message: "The userId, reward and taskName are required",
    });
  }

  const message = {
    notification: {
      title: "Reward Earned!",
      body: `Congratulations! You've earned ${reward} G-Tokens reward for completing '${taskName}' task`,
    },
    data: {
      notification: "18",
      information: JSON.stringify({
        reward: reward,
        taskName: taskName,
      }),
      image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fgift-solid-full.png?alt=media&token=e373694e-bf98-442a-887b-e77e16aec8f9",
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
        title: "Reward Earned!",
        titleEsp: "¡Recompensa Ganada!",
        content: `Congratulations! You've earned ${reward} G-Tokens reward for completing '${taskName}' task`,
        contentEsp: `¡Felicidades! Has ganado ${reward} G-Tokens de recompensa por completar la tarea '${taskName}'`,
        notificationType: "18",
        isRead: false,
        date: Timestamp.now(),
        image: "https://firebasestorage.googleapis.com/v0/b/g-play-dev-e4c4c.firebasestorage.app/o/notification%2Fgift-solid-full.png?alt=media&token=e373694e-bf98-442a-887b-e77e16aec8f9",
        eventId: "",
        eventHost: "",
        navigation: "rewards",
      }),
    });

    console.log("Notification successfully added to user document.");
    return res.status(200).send({message: "Notification sent successfully"});
  } catch (error) {
    console.error("Error sending sendNotificationRewardEarned notification:", error);
    return res.status(500).send({
      error: "internal",
      message: "Error sending sendNotificationRewardEarned notification",
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
// async function processInChunks(array, chunkSize, processor) {
//   const results = [];
//   for (let i = 0; i < array.length; i += chunkSize) {
//     const chunk = array.slice(i, i + chunkSize);
//     console.log(chunk);
//     console.log("chunk");
//     const chunkResults = await Promise.all(chunk.map(processor));
//     results.push(...chunkResults);
//     console.log(results);
//     console.log("results");
//   }
//   return results;
// }

/**
 * Gets current date formatted as YYYY-MM-DD string
 * @return {string} Formatted date string in YYYY-MM-DD format
 */
// function getFormattedDate() {
//   const now = new Date();
//   return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
// }

// ==================== APPLE IN-APP PURCHASE VALIDATION ====================

// Apple's receipt validation URLs
const APPLE_PRODUCTION_URL = "https://buy.itunes.apple.com/verifyReceipt";
const APPLE_SANDBOX_URL = "https://sandbox.itunes.apple.com/verifyReceipt";

// Your App's Shared Secret from App Store Connect
// Set with: firebase functions:config:set apple.shared_secret="YOUR_SECRET"
const getAppleSharedSecret = () => {
  return functions.config().apple?.shared_secret || process.env.APPLE_SHARED_SECRET || "";
};

/**
 * Validates an Apple receipt with Apple's servers
 */
exports.validateAppleReceipt = functions.runWith({memory: "1GB"}).https.onCall(async (data, context) => {
  const {receiptData, productId, transactionId} = data;

  if (!receiptData) {
    throw new functions.https.HttpsError("invalid-argument", "Receipt data is required");
  }

  try {
    // First try production URL
    let result = await validateWithApple(receiptData, APPLE_PRODUCTION_URL);

    // If status is 21007, receipt is from sandbox, retry with sandbox URL
    if (result.status === 21007) {
      result = await validateWithApple(receiptData, APPLE_SANDBOX_URL);
    }

    // Check if valid
    if (result.status === 0) {
      // Receipt is valid
      const receipt = result.receipt;
      const inAppPurchases = receipt.in_app || [];

      // Find the specific transaction
      const purchase = inAppPurchases.find(
          (p) => p.product_id === productId || p.transaction_id === transactionId,
      );

      if (purchase) {
        console.log("Valid Apple purchase:", {
          productId: purchase.product_id,
          transactionId: purchase.transaction_id,
          purchaseDate: purchase.purchase_date,
        });

        return {
          valid: true,
          productId: purchase.product_id,
          transactionId: purchase.transaction_id,
          purchaseDate: purchase.purchase_date,
        };
      } else {
        console.log("Product not found in Apple receipt");
        return {valid: false, error: "Product not found in receipt"};
      }
    } else {
      console.log("Apple receipt validation failed with status:", result.status);
      return {valid: false, status: result.status, error: getAppleStatusMessage(result.status)};
    }
  } catch (error) {
    console.error("Error validating Apple receipt:", error);
    throw new functions.https.HttpsError("internal", "Failed to validate receipt");
  }
});

/**
 * Send receipt to Apple for validation
 * @param {string} receiptData - Base64 encoded receipt data from the app
 * @param {string} url - Apple's verification URL (production or sandbox)
 * @return {Promise<Object>} Apple's validation response
 */
async function validateWithApple(receiptData, url) {
  const fetch = (await import("node-fetch")).default;

  const requestBody = {
    "receipt-data": receiptData,
    "password": getAppleSharedSecret(),
    "exclude-old-transactions": true,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });

  return await response.json();
}

/**
 * Get human-readable Apple status message
 * @param {number} status - Apple's status code from receipt validation
 * @return {string} Human-readable error message
 */
function getAppleStatusMessage(status) {
  const messages = {
    21000: "The request to the App Store was not made using the HTTP POST request method.",
    21001: "This status code is no longer sent by the App Store.",
    21002: "The data in the receipt-data property was malformed or the service experienced a temporary issue.",
    21003: "The receipt could not be authenticated.",
    21004: "The shared secret you provided does not match the shared secret on file for your account.",
    21005: "The receipt server was temporarily unable to provide the receipt.",
    21006: "This receipt is valid but the subscription has expired.",
    21007: "This receipt is from the test environment (sandbox).",
    21008: "This receipt is from the production environment.",
    21009: "Internal data access error.",
    21010: "The user account cannot be found or has been deleted.",
  };
  return messages[status] || `Unknown status: ${status}`;
}

// ==================== GOOGLE PLAY IN-APP PURCHASE VALIDATION ====================

const {google} = require("googleapis");

// Initialize Google Play Developer API
const androidPublisher = google.androidpublisher("v3");

/**
 * Validates a Google Play purchase
 * Called from the Flutter app after a purchase is made
 * @param {Object} data - The purchase data from the client
 * @param {Object} context - Firebase callable context
 * @return {Promise<Object>} Validation result
 */
exports.validateGooglePurchase = functions.https.onCall(async (data, context) => {
  const {purchaseToken, productId, packageName} = data;

  // Validate input
  if (!purchaseToken || !productId || !packageName) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing required parameters: purchaseToken, productId, packageName",
    );
  }

  try {
    // Authenticate with Google using service account
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });

    const authClient = await auth.getClient();

    // Log which service account is being used
    const credentials = await auth.getCredentials();
    console.log("Using service account:", credentials.client_email);

    // Verify the purchase with Google Play
    const response = await androidPublisher.purchases.products.get({
      auth: authClient,
      packageName: packageName,
      productId: productId,
      token: purchaseToken,
    });

    const purchase = response.data;

    // Check purchase state
    // 0 = Purchased
    // 1 = Canceled
    // 2 = Pending
    const purchaseState = purchase.purchaseState;

    if (purchaseState === 0) {
      console.log("Valid Google Play purchase:", {
        orderId: purchase.orderId,
        purchaseTime: purchase.purchaseTimeMillis,
        productId: productId,
      });

      return {
        valid: true,
        orderId: purchase.orderId,
        purchaseTime: purchase.purchaseTimeMillis,
        consumptionState: purchase.consumptionState,
      };
    } else if (purchaseState === 1) {
      console.log("Google Play purchase was canceled:", productId);
      return {
        valid: false,
        reason: "Purchase was canceled",
      };
    } else if (purchaseState === 2) {
      console.log("Google Play purchase is pending:", productId);
      return {
        valid: false,
        reason: "Purchase is pending",
      };
    } else {
      return {
        valid: false,
        reason: "Unknown purchase state",
      };
    }
  } catch (error) {
    console.error("Error validating Google Play purchase:", error);

    // Check for specific Google API errors
    if (error.code === 404) {
      return {
        valid: false,
        reason: "Purchase not found",
      };
    }

    throw new functions.https.HttpsError(
        "internal",
        "Error validating purchase: " + error.message,
    );
  }
});
