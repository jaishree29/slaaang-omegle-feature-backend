// functions/index.js

// EDIT 1: Add firebase-functions and switch from 'ws' to 'express' and 'socket.io'
const functions = require("firebase-functions");
const express = require('express');
const http = require("http");
const { Server } = require("socket.io");
const { randomUUID } = require('crypto'); // This is no longer needed but kept for reference

// EDIT 2: Set up an Express app, which is standard for Cloud Functions
const app = express();
const server = http.createServer(app);

// EDIT 3: Initialize Socket.IO server and configure CORS
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for simplicity, restrict this in production
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    }
});

// EDIT 4: Remove the manual server.listen() block. Firebase handles this.
/*
const port = process.env.PORT || 8080;
server.listen(port, '0.0.0.0', () => {
  console.log(`✅ Server started on port ${port}`);
});
*/

const clients = new Map();
let waitingUsers = [];

const log = (message, level = 'INFO') => {
  console.log(`[${new Date().toISOString()}] ${level}: ${message}`);
};

function isCompatible(userA, userB) {

  if (userA.id === userB.id) return false;
  const prefsA = userA.payload;
  const prefsB = userB.payload;

  if (prefsA.interest && prefsB.interest && prefsA.interest !== prefsB.interest) {
      return false;
  }

  const userAWants = prefsA.partnerPreference === 'same' ? prefsA.gender : 'any';
  const userBWants = prefsB.partnerPreference === 'same' ? prefsB.gender : 'any';

  const aIsHappy = userAWants === 'any' || userAWants === prefsB.gender;
  const bIsHappy = userBWants === 'any' || userBWants === prefsA.gender;

  return aIsHappy && bIsHappy;
}

// EDIT 5: Change the connection event listener from 'wss.on' to 'io.on'
io.on('connection', (socket) => {
    // EDIT 6: Use the built-in socket.id as the unique client ID.
    const clientId = socket.id;
    clients.set(clientId, socket);
  socket.partnerId = null;
  
  
socket.on('skip', () => {
    if (socket.partnerId) {
        const partnerSocket = clients.get(socket.partnerId);
        if (partnerSocket) {
            partnerSocket.emit('partnerSkipped', { from: clientId });
            partnerSocket.partnerId = null;
        }
        socket.partnerId = null;
    }

    // Put this user back into waiting pool
    waitingUsers = waitingUsers.filter(user => user.id !== clientId);
    waitingUsers.push({ id: clientId, payload: {} });

    log(`Client ${clientId} skipped. Returned to waiting pool.`);
});

    // EDIT 7: Send messages using socket.emit() instead of ws.send()
    socket.emit('welcome', { id: clientId });
    log(`Client ${clientId} connected`);

    // EDIT 8: Listen for custom events. This is more idiomatic for Socket.IO.
    socket.on('waiting', (data) => {
        try {
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
                const partnerSocket = clients.get(partner.id);

                if (partnerSocket) {
                    socket.partnerId = partner.id;
                    partnerSocket.partnerId = clientId;
                    
                    // EDIT 9: Use socket.emit() to send the 'paired' event.
                    partnerSocket.emit('paired', {
                        partnerId: clientId,
                        isInitiator: true
                    });
                    
                    socket.emit('paired', {
                        partnerId: partner.id,
                        isInitiator: false
                    });

                    log(`✅ Paired ${clientId} with ${partner.id}`);
                } else {
                    log(`Stale partner ${partner.id} found. Adding ${clientId} to waiting list.`);
                    waitingUsers.push(newUser);
                }
            } else {
                waitingUsers.push(newUser);
                log(`Client ${clientId} added to waiting list. Waiting: ${waitingUsers.length}`);
            }
        } catch (e) {
            log(`Error in 'waiting' event: ${e.message}`, 'ERROR');
        }
    });

    // EDIT 10: Set up a single handler to relay WebRTC signals
    const relayHandler = (eventName) => {
        socket.on(eventName, (data) => {
            const targetSocket = clients.get(data.to);
            if (targetSocket) {
                // Add the 'from' field and emit to the target client
                data.from = clientId;
                targetSocket.emit(eventName, data);
            }
        });
    };
    
    ['offer', 'answer', 'iceCandidate', 'message', 'disconnected', 'toggleVideo'].forEach(relayHandler);

    // EDIT 11: Change 'close' event to 'disconnect'
    socket.on('disconnect', () => {
        log(`Client ${clientId} disconnected`);
        clients.delete(clientId);
        
      waitingUsers = waitingUsers.filter(user => user.id !== clientId);
      
      if (socket.partnerId) {
    const partnerSocket = clients.get(socket.partnerId);
    if (partnerSocket) {
        partnerSocket.emit('disconnected', { from: clientId });
        partnerSocket.partnerId = null;

        // Put partner back into waiting pool with preserved prefs
        waitingUsers.push({ id: partnerSocket.id, payload: partnerSocket.userPayload || {} });
    }
}
        
        
    });
});

// EDIT 12: Remove all setInterval blocks. They are not reliable in a serverless environment.
// The 'disconnect' event will handle all cleanup.

// // EDIT 13: Export the entire Express server as a Cloud Function v2. This is the final, crucial step.
// exports.api = functions.v2.https.onRequest(server);
const port = process.env.PORT || 8080; // Render will set the PORT variable
server.listen(port, () => {
  console.log(`✅ Server is listening on port ${port}`);
});
