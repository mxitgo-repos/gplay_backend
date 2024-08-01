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
  res.set('Access-Control-Allow-Origin', '*'); // Ajusta esto según sea necesario
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '3600');
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).send("Method not allowed");
  }

  const { startDate, endDate } = req.body;

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

    const activeUsers = users.users.filter(user => {
      const lastLogin = user.metadata.lastSignInTime ? new Date(user.metadata.lastSignInTime).getTime() : 0;
      return lastLogin >= start && lastLogin <= end;
    });

    const count = activeUsers.length;

    return res.status(200).send({ count });
  } catch (error) {
    return res.status(500).send({
      error: "internal",
      message: "Error getting users",
      details: error.message,
    });
  }
});