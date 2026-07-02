/**
 * socket.js — Socket.IO setup untuk realtime update
 * Taruh di root be-sm-mobile/, sejajar server.js
 */

const { Server } = require('socket.io');

let io = null;

// Map userId -> array of socket.id (1 user bisa punya banyak koneksi/device)
const userSockets = new Map();

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log('[SOCKET] Client connected:', socket.id);

    // Mobile / backoffice register diri dengan userId setelah konek
    socket.on('register', (userId) => {
      if (!userId) return;
      const id = String(userId);
      if (!userSockets.has(id)) userSockets.set(id, new Set());
      userSockets.get(id).add(socket.id);
      socket.userId = id;
      console.log(`[SOCKET] User ${id} registered (${socket.id})`);
    });

    // Backoffice register sebagai room khusus supaya gampang broadcast
    socket.on('register-backoffice', () => {
      socket.join('backoffice');
      console.log(`[SOCKET] Backoffice joined: ${socket.id}`);
    });

    socket.on('disconnect', () => {
      if (socket.userId && userSockets.has(socket.userId)) {
        userSockets.get(socket.userId).delete(socket.id);
        if (userSockets.get(socket.userId).size === 0) {
          userSockets.delete(socket.userId);
        }
      }
      console.log('[SOCKET] Disconnected:', socket.id);
    });
  });

  return io;
}

/**
 * Emit event ke 1 user spesifik (semua device dia)
 */
function emitToUser(userId, event, payload) {
  if (!io) return;
  const id = String(userId);
  const sockets = userSockets.get(id);
  if (!sockets || sockets.size === 0) return;
  sockets.forEach((sid) => io.to(sid).emit(event, payload));
}

/**
 * Emit event ke semua backoffice yang konek
 */
function emitToBackoffice(event, payload) {
  if (!io) return;
  io.to('backoffice').emit(event, payload);
}

/**
 * Emit event ke semua client (broadcast)
 */
function emitToAll(event, payload) {
  if (!io) return;
  io.emit(event, payload);
}

module.exports = {
  initSocket,
  emitToUser,
  emitToBackoffice,
  emitToAll,
};