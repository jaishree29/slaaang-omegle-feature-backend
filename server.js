const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const server = require("http").createServer();
const wss = new WebSocket.Server({ server });

server.listen(8080, '0.0.0.0', () => {
  console.log("Server started on 0.0.0.0:8080");
});

const clients = new Map();
let waitingUsers = [];

const log = (message, level = 'INFO') => {
  console.log(`[${new Date().toISOString()}] ${level}: ${message}`);
};

function generateId() {
  return randomUUID();
}

wss.on('connection', (ws) => {
  const clientId = generateId();
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

      if (data.type === 'waiting') {
        if (waitingUsers.length > 0) {
          const partnerId = waitingUsers.shift();
          const partnerWs = clients.get(partnerId);
          if (partnerWs && partnerWs.readyState === WebSocket.OPEN) {
            ws.partnerId = partnerId;
            partnerWs.partnerId = clientId;
            ws.send(JSON.stringify({ 
              type: 'paired', 
              partnerId,
              isInitiator: false 
            }));
            partnerWs.send(JSON.stringify({ 
              type: 'paired', 
              partnerId: clientId,
              isInitiator: true 
            }));
            log(`Paired ${clientId} with ${partnerId}`);
          } else {
            waitingUsers.push(clientId);
          }
        } else {
          waitingUsers.push(clientId);
          log(`Client ${clientId} added to waiting list`);
        }
      }

      if (['offer', 'answer', 'iceCandidate', 'disconnected', 'message', 'toggleVideo', 'toggleAudio'].includes(data.type)) {
        const targetWs = clients.get(data.to);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(JSON.stringify({
            type: data.type,
            from: data.from,
            payload: data.payload
          }));
          log(`Relayed ${data.type} from ${data.from} to ${data.to}`);
        }
      }
    } catch (e) {
      log(`Error processing message: ${e.message}`, 'ERROR');
    }
  });

  ws.on('close', () => {
    log(`Client ${clientId} disconnected`);
    clients.delete(clientId);
    waitingUsers = waitingUsers.filter(id => id !== clientId);
    
    if (ws.partnerId) {
      const partnerWs = clients.get(ws.partnerId);
      if (partnerWs) {
        partnerWs.send(JSON.stringify({ type: 'disconnected', from: clientId }));
        partnerWs.partnerId = null;
      }
    }
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
});

setInterval(() => {
  waitingUsers = waitingUsers.filter(id => {
    const ws = clients.get(id);
    return ws && ws.readyState === WebSocket.OPEN;
  });
}, 60000);