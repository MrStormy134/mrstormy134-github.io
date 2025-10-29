const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '..', 'public')));

// load words
const WORDS = fs.readFileSync(path.join(__dirname, 'words.txt'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(w => w.trim().toLowerCase());

function makeRoomCode(len = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // avoid ambiguous chars
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// In-memory room store (for demo). For production use DB.
const rooms = new Map();

function pickWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function evaluateGuess(secret, guess) {
  // returns array of 'correct' | 'present' | 'absent' per letter
  secret = secret.split('');
  guess = guess.split('');
  const res = Array(guess.length).fill('absent');

  // first pass for correct
  const secretRemaining = [];
  for (let i = 0; i < guess.length; i++) {
    if (guess[i] === secret[i]) {
      res[i] = 'correct';
      secret[i] = null; // consume
    }
  }
  // second pass for present
  for (let i = 0; i < guess.length; i++) {
    if (res[i] === 'correct') continue;
    const idx = secret.indexOf(guess[i]);
    if (idx !== -1) {
      res[i] = 'present';
      secret[idx] = null; // consume
    }
  }
  return res;
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('createRoom', ({name, word}) => {
    const code = makeRoomCode(5);
    const room = {
      code,
      host: socket.id,
      players: new Map(), // id -> {name, guesses:[], solvedAt: null}
      started: false,
      secret: word ? word.toLowerCase() : null,
      createdAt: Date.now(),
    };
    rooms.set(code, room);

    socket.join(code);
    room.players.set(socket.id, { name: name || 'Host', guesses: [], solvedAt: null, connected: true});

    io.to(socket.id).emit('roomCreated', { code, roomState: serializeRoom(room) });
  });

  socket.on('joinRoom', ({code, name}, cb) => {
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Room not found' });
    if (room.started) return cb && cb({ error: 'Game already started' });

    socket.join(code);
    room.players.set(socket.id, { name: name || 'Player', guesses: [], solvedAt: null, connected: true});

    io.to(code).emit('roomUpdated', { roomState: serializeRoom(room) });
    cb && cb({ ok: true, roomState: serializeRoom(room) });
  });

  socket.on('startGame', ({code, chosenWord}, cb) => {
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Room not found' });
    if (room.host !== socket.id) return cb && cb({ error: 'Only host can start' });
    if (room.started) return cb && cb({ error: 'Already started' });

    room.secret = chosenWord ? chosenWord.toLowerCase() : pickWord();
    room.started = true;
    room.startedAt = Date.now();

    io.to(code).emit('gameStarted', { roomState: serializeRoom(room) });
    cb && cb({ ok: true });
  });

  socket.on('submitGuess', ({code, guess}, cb) => {
    const room = rooms.get(code);
    if (!room) return cb && cb({ error: 'Room not found' });
    if (!room.started) return cb && cb({ error: 'Game not started' });
    guess = guess.trim().toLowerCase();
    if (!guess || guess.length !== room.secret.length) return cb && cb({ error: 'Invalid guess length' });

    const player = room.players.get(socket.id);
    if (!player) return cb && cb({ error: 'Not in room' });

    const feedback = evaluateGuess(room.secret, guess);
    player.guesses.push({ guess, feedback, at: Date.now() });

    if (feedback.every(x => x === 'correct')) {
      // solved
      player.solvedAt = Date.now();
    }

    io.to(code).emit('playerUpdate', { playerId: socket.id, snapshot: player, roomState: serializeRoom(room) });

    // check for winner
    const winners = Array.from(room.players.entries())
      .filter(([, p]) => p.solvedAt)
      .map(([id, p]) => ({ id, name: p.name, solvedAt: p.solvedAt, guesses: p.guesses.length }));

    if (winners.length > 0) {
      // determine winner using earliest solvedAt -> fewest guesses -> earlier
      winners.sort((a, b) => {
        if (a.solvedAt !== b.solvedAt) return a.solvedAt - b.solvedAt;
        if (a.guesses !== b.guesses) return a.guesses - b.guesses;
        return 0;
      });
      io.to(code).emit('roundComplete', { winners, secret: room.secret });
      room.started = false; // end round
    }

    cb && cb({ ok: true, feedback });
  });

  socket.on('leaveRoom', ({code}) => {
    leaveRoom(socket, code);
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    // mark disconnected players
    for (const [code, room] of rooms.entries()) {
      if (room.players.has(socket.id)) {
        const p = room.players.get(socket.id);
        p.connected = false;
        io.to(code).emit('roomUpdated', { roomState: serializeRoom(room) });
      }
    }
  });

  function leaveRoom(socket, code) {
    const room = rooms.get(code);
    if (!room) return;
    socket.leave(code);
    room.players.delete(socket.id);
    io.to(code).emit('roomUpdated', { roomState: serializeRoom(room) });
    if (room.players.size === 0) {
      rooms.delete(code);
    } else if (room.host === socket.id) {
      // pick a new host
      const newHostId = room.players.keys().next().value;
      room.host = newHostId;
      io.to(code).emit('roomUpdated', { roomState: serializeRoom(room) });
    }
  }

  function serializeRoom(room) {
    return {
      code: room.code,
      host: room.host,
      started: room.started,
      playerCount: room.players.size,
      players: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, guesses: p.guesses.length, solvedAt: p.solvedAt, connected: p.connected })),
      createdAt: room.createdAt,
      // for transparency we don't include secret unless the round is over in events
      startedAt: room.startedAt || null,
    };
  }
});

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
