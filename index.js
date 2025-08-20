// functions/index.js

const { onRequest } = require("firebase-functions/v2/https");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
// This middleware is crucial for handling the initial connection request
app.use(cors({ origin: "*" }));

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*", // Allows your web app to connect
        methods: ["GET", "POST"]
    }
});

const clients = new Map();
let waitingUsers = [];

function isCompatible(userA, userB) {
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

io.on('connection', (socket) => {
    const clientId = socket.id;
    clients.set(clientId, socket);
    socket.partnerId = null;

    socket.emit('welcome', { id: clientId });
    console.log(`Client ${clientId} connected.`);

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
                    partnerSocket.emit('paired', { partnerId: clientId, isInitiator: true });
                    socket.emit('paired', { partnerId: partner.id, isInitiator: false });
                    console.log(`✅ Paired ${clientId} with ${partner.id}`);
                } else {
                    waitingUsers.push(newUser);
                }
            } else {
                waitingUsers.push(newUser);
            }
        } catch (e) {
            console.log(`Error in 'waiting' event: ${e.message}`);
        }
    });

    const relayHandler = (eventName) => {
        socket.on(eventName, (data) => {
            const targetSocket = clients.get(data.to);
            if (targetSocket) {
                data.from = clientId;
                targetSocket.emit(eventName, data);
            }
        });
    };
    
    ['offer', 'answer', 'iceCandidate', 'message', 'disconnected', 'toggleVideo'].forEach(relayHandler);

    socket.on('disconnect', () => {
        console.log(`Client ${clientId} disconnected`);
        clients.delete(clientId);
        waitingUsers = waitingUsers.filter(user => user.id !== clientId);
        if (socket.partnerId) {
            const partnerSocket = clients.get(socket.partnerId);
            if (partnerSocket) {
                partnerSocket.emit('disconnected', { from: clientId });
                partnerSocket.partnerId = null;
            }
        }
    });
});

// Export the server using the v2 onRequest syntax
exports.api = onRequest({ maxInstances: 10 }, server);