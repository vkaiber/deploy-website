const { MongoClient } = require("mongodb");

let client = null;
let collection = null;
let connected = false;
let lastError = null;

async function initMongo(uri, initialData) {
  if (!uri) return { enabled: false, connected: false, data: initialData };
  try {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 5
    });
    await client.connect();
    const db = client.db();
    collection = db.collection("deploy-website_state");
    const doc = await collection.findOne({ _id: "main" });
    connected = true;
    lastError = null;
    return {
      enabled: true,
      connected: true,
      data: doc?.data && typeof doc.data === "object" ? doc.data : initialData
    };
  } catch (error) {
    connected = false;
    lastError = error.message;
    try { await client?.close(); } catch {}
    client = null;
    collection = null;
    return { enabled: true, connected: false, data: initialData, error: error.message };
  }
}

function queueSave(data) {
  if (!collection) return;
  collection.updateOne(
    { _id: "main" },
    { $set: { data, updatedAt: new Date() } },
    { upsert: true }
  ).catch(error => {
    connected = false;
    lastError = error.message;
  });
}

function status() {
  return {
    configured: !!collection,
    connected,
    error: lastError
  };
}

async function closeMongo() {
  try { await client?.close(); } catch {}
  client = null;
  collection = null;
  connected = false;
}

module.exports = { initMongo, queueSave, status, closeMongo };
