const { onRequest } = require("firebase-functions/v2/https");
const { randomUUID } = require("crypto");
const logger = require("firebase-functions/logger");

// In-memory storage for clients and waiting users (note: this is not persistent across function instances)
const clients = new Map();
let waitingUsers = [];

const log = (message, level = 'INFO') => {
  logger.log(`[${new Date().toISOString()}] ${level}: ${message}`);
};

/**
 * Checks if two users are compatible based on their preferences.
 */
function isCompatible(userA, userB) {
  const prefsA = userA.payload;
  const prefsB = userB.payload;

  // Rule 1: Interest Matching (Optional)
  if (prefsA.interest && prefsB.interest) {
    if (prefsA.interest !== prefsB.interest) {
      return false;
    }
  }

  // Rule 2: Gender Preference Matching (Two-Way Check)
  const userAWants = prefsA.partnerPreference === 'same' ? prefsA.gender : 'any';
  const userBWants = prefsB.partnerPreference === 'same' ? prefsB.gender : 'any';

  const aIsHappy = userAWants === 'any' || userAWants === prefsB.gender;
  const bIsHappy = userBWants === 'any' || userBWants === prefsA.gender;

  return aIsHappy && bIsHappy;
}

// --- CORRECTED FUNCTION ---
// This now correctly pushes messages to the client's queue.
function handleSend(clientId, message) {
  const targetClient = clients.get(clientId);
  if (targetClient) {
    // Ensure the message is an object before pushing
    const messageObject = typeof message === 'string' ? JSON.parse(message) : message;
    targetClient.messageQueue.push(messageObject);
    log(`Queued message for ${clientId}`);
  } else {
    log(`Client ${clientId} not found for sending message.`, 'WARN');
  }
}

exports.socketServer = onRequest({ cors: true }, (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const data = req.body;
  let clientId = data.clientId;

  // More robustly handle client creation and retrieval.
  if (!clientId || !clients.has(clientId)) {
    clientId = randomUUID();
    const newClient = {
      clientId,
      partnerId: null,
      messageQueue: []
    };
    clients.set(clientId, newClient);
    log(`Client ${clientId} connected.`);
    // Queue the welcome message for the new client.
    newClient.messageQueue.push({ type: 'welcome', id: clientId });
  }

  // Always get the client from the map to ensure we have the correct object.
  const client = clients.get(clientId);

  // --- REMOVED ---
  // The old, conflicting client creation logic (`if (!ws)`) was removed from here.
  // The check for `!data.type` was also removed as it prevented the initial connection.

  try {
    // Only process a message type if it exists
    if (data.type) {
        if (data.type === 'waiting') {
            const newUser = { id: clientId, payload: data.payload };
            let partner = null;
            let partnerIndex = -1;
    
            for (let i = 0; i < waitingUsers.length; i++) {
              if (isCompatible(newUser, waitingUsers[i])) {
                partner = waitingUsers[i];
                partnerIndex = i;
                break;
              }
            }
    
            if (partner) {
              waitingUsers.splice(partnerIndex, 1);
              const partnerClient = clients.get(partner.id);
    
              if (partnerClient) {
                client.partnerId = partner.id;
                partnerClient.partnerId = clientId;
    
                handleSend(partner.id, {
                  type: 'paired',
                  partnerId: clientId,
                  isInitiator: true
                });
    
                handleSend(clientId, {
                  type: 'paired',
                  partnerId: partner.id,
                  isInitiator: false
                });
    
                log(`✅ Paired ${clientId} with ${partner.id}`);
              } else {
                if (partnerClient) clients.delete(partner.id);
                log(`Stale partner ${partner.id} found. Adding ${clientId} to waiting list.`);
                waitingUsers.push(newUser);
              }
            } else {
              waitingUsers.push(newUser);
              log(`Client ${clientId} added to waiting list. Waiting: ${waitingUsers.length}`);
            }
          } else if (['offer', 'answer', 'iceCandidate', 'disconnected', 'message', 'toggleVideo', 'toggleAudio'].includes(data.type)) {
            const targetClient = clients.get(data.to);
            if (targetClient) {
              data.from = clientId;
              handleSend(data.to, data);
            }
          }
    }
  } catch (e) {
    log(`Error processing message: ${e.message}`, 'ERROR');
    // We still want to send queued messages even if there's an error with the incoming one.
  }

  // --- CONSOLIDATED RESPONSE ---
  // All intermediate `res.send()` and `res.json()` calls were removed.
  // This is now the ONLY response sent, ensuring the polling works correctly.
  const messagesToSend = client ? [...client.messageQueue] : [];
  if (client) {
    client.messageQueue = []; // Clear the queue
  }
  return res.status(200).json({ messages: messagesToSend });
});


// Cleanup function remains the same, but uses the corrected handleSend
exports.cleanup = onRequest({ cors: true }, (req, res) => {
  if (req.method !== 'POST' || !req.body.clientId) {
    return res.status(400).send('Invalid request');
  }

  const clientId = req.body.clientId;
  const client = clients.get(clientId);

  if (client) {
    log(`Client ${clientId} disconnected`);
    
    if (client.partnerId) {
      const partnerClient = clients.get(client.partnerId);
      if (partnerClient) {
        handleSend(client.partnerId, { type: 'disconnected', from: clientId });
        partnerClient.partnerId = null;
      }
    }
    
    clients.delete(clientId);
    waitingUsers = waitingUsers.filter(user => user.id !== clientId);
  }

  res.status(200).send('OK');
});

// This can be removed if you don't need it, as Cloud Functions instances are stateless.
// It will only run for the lifetime of a single function instance.
setInterval(() => {
  const initialCount = waitingUsers.length;
  waitingUsers = waitingUsers.filter(user => clients.has(user.id));
  if (initialCount > waitingUsers.length) {
    log(`Cleaned up ${initialCount - waitingUsers.length} stale users from waiting list.`);
  }
}, 60000);