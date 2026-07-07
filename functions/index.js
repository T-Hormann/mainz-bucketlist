const functions = require("firebase-functions/v1");
const admin = require("firebase-admin");
admin.initializeApp();

const LABELS = {
  chat:   (n) => `Neue Nachricht von ${n}`,
  task:   (n) => `Neue Aufgabe von ${n}`,
  invite: (n) => `${n} hat einen neuen Trip / ein Event vorgeschlagen`,
  vote:   (n) => `${n} hat eine neue Abstimmung gestartet`,
};

// Ausloeser: neues Signal unter /groups/<g>/notify/<id>
exports.notify = functions
  .region("europe-west1")
  .database.instance("agraffen55116-default-rtdb")
  .ref("/groups/{g}/notify/{id}")
  .onCreate(async (snap, ctx) => {
    const sig = snap.val() || {};
    const type = sig.type || "chat";
    const by = sig.by || "Jemand";
    const g = ctx.params.g;
    const db = admin.database();

    const notifSnap = await db.ref(`/groups/${g}/notif`).once("value");
    const notif = notifSnap.val() || {};

    const targets = [];
    for (const name in notif) {
      if (name === by) continue;
      const p = notif[name] || {};
      if (!p.enabled || !p.token) continue;
      if (p[type] === false) continue;
      targets.push({ name, token: p.token });
    }

    await snap.ref.remove();
    if (!targets.length) return null;

    const body = (LABELS[type] || LABELS.chat)(by);
    const resp = await admin.messaging().sendEachForMulticast({
      tokens: targets.map((t) => t.token),
      data: { title: "Agraffen", body, tag: "agraffen-" + type },
    });

    const dead = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-argument") {
          dead.push(targets[i].name);
        }
      }
    });
    await Promise.all(dead.map((name) =>
      db.ref(`/groups/${g}/notif/${name}/token`).remove()));
    return null;
  });
