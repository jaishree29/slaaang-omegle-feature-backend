const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

const port = process.env.PORT || 8080;
server.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server started on port ${port}`);
});

const clients = new Map();
// MODIFICATION: `waitingUsers` now stores full user objects with their preferences.
let waitingUsers = [];

const log = (message, level = 'INFO') => {
  console.log(`[${new Date().toISOString()}] ${level}: ${message}`);
};

/**
 * Checks if two users are compatible based on their preferences.
 * This is the core of the matching logic.
 * @param {object} userA - The first user object { id, payload }.
 * @param {object} userB - The second user object { id, payload }.
 * @returns {boolean} - True if users are a match.
 */
function isCompatible(userA, userB) {
  const prefsA = userA.payload;
  const prefsB = userB.payload;

  // Rule 1: Interest Matching (Optional)
  // If both users specified an interest (not an empty string), they MUST match.
  if (prefsA.interest && prefsB.interest) {
    if (prefsA.interest !== prefsB.interest) {
      return false; // Interests were specified but do not match.
    }
  }

  // Rule 2: Gender Preference Matching (Two-Way Check)
  // Determine what gender each user wants to connect with.
  const userAWants = prefsA.partnerPreference === 'same' ? prefsA.gender : 'any';
  const userBWants = prefsB.partnerPreference === 'same' ? prefsB.gender : 'any';

  // A match is only valid if User A is happy with User B's gender, AND User B is happy with User A's gender.
  const aIsHappy = userAWants === 'any' || userAWants === prefsB.gender;
  const bIsHappy = userBWants === 'any' || userBWants === prefsA.gender;

  // If both are happy, it's a match.
  return aIsHappy && bIsHappy;
}


wss.on('connection', (ws) => {
  const clientId = randomUUID();
  clients.set(clientId, ws);
  ws.clientId = clientId;
  ws.partnerId = null;

  ws.send(JSON.stringify({ type: 'welcome', id: clientId }));
  log(`Client ${clientId} connected`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (!data.type) {
        throw new Error('Missing message type');
      }

      // ===================================================================
      // MODIFICATION: Rewritten matchmaking logic for the 'waiting' type.
      // ===================================================================
      if (data.type === 'waiting') {
        const newUser = { id: clientId, payload: data.payload };
        let partner = null;
        let partnerIndex = -1;

        // Find a compatible partner from the waiting list.
        for (let i = 0; i < waitingUsers.length; i++) {
          if (isCompatible(newUser, waitingUsers[i])) {
            partner = waitingUsers[i];
            partnerIndex = i;
            break; // Match found, no need to check further.
          }
        }

        if (partner) {
          // A compatible partner was found!
          // Remove the partner from the waiting list.
          waitingUsers.splice(partnerIndex, 1);
          
          const partnerWs = clients.get(partner.id);

          if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
            // Set partner IDs for both connections.
            ws.partnerId = partner.id;
            partnerWs.partnerId = clientId;

            // Send 'paired' messages to both clients to initiate the WebRTC handshake.
            // The initiator is responsible for creating the initial offer.
            partnerWs.send(JSON.stringify({
              type: 'paired',
              partnerId: clientId,
              isInitiator: true
            }));
            
            ws.send(JSON.stringify({
              type: 'paired',
              partnerId: partner.id,
              isInitiator: false
            }));

            log(`✅ Paired ${clientId} (${newUser.payload.gender}) with ${partner.id} (${partner.payload.gender})`);
          } else {
            // Partner was found but their connection is closed. Add new user to waitlist.
             if (partnerWs) clients.delete(partner.id); // Clean up stale client
             log(`Stale partner ${partner.id} found. Adding ${clientId} to waiting list.`);
             waitingUsers.push(newUser);
          }
        } else {
          // No compatible partner found, add the new user to the waiting list.
          waitingUsers.push(newUser);
          log(`Client ${clientId} added to waiting list. Waiting: ${waitingUsers.length}`);
        }
      }
      // ===================================================================
      // End of matchmaking logic modification.
      // ===================================================================

      // The rest of the message relaying logic remains the same.
      if (['offer', 'answer', 'iceCandidate', 'disconnected', 'message', 'toggleVideo', 'toggleAudio'].includes(data.type)) {
        const targetWs = clients.get(data.to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          // Add the 'from' field to the message so the recipient knows the sender.
          data.from = clientId;
          targetWs.send(JSON.stringify(data));
        }
      }
    } catch (e) {
      log(`Error processing message: ${e.message}`, 'ERROR');
    }
  });

  ws.on('close', () => {
    log(`Client ${clientId} disconnected`);
    clients.delete(clientId);
    
    // MODIFICATION: Filter waiting users by their ID property.
    waitingUsers = waitingUsers.filter(user => user.id !== clientId);
    
    // Notify the partner about the disconnection.
    if (ws.partnerId) {
      const partnerWs = clients.get(ws.partnerId);
      if (partnerWs) {
        partnerWs.send(JSON.stringify({ type: 'disconnected', from: clientId }));
        partnerWs.partnerId = null;
      }
    }
  });

  // Keep-alive mechanism to detect broken connections.
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
});

// Periodically clean up any disconnected clients from the waiting list.
setInterval(() => {
  const initialCount = waitingUsers.length;
  waitingUsers = waitingUsers.filter(user => {
    const ws = clients.get(user.id);
    return ws && ws.readyState === WebSocket.OPEN;
  });
  if(initialCount > waitingUsers.length){
    log(`Cleaned up ${initialCount - waitingUsers.length} stale users from waiting list.`);
  }
}, 60000);