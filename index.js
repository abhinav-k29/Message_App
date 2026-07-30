const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const path = require("path");
const { Server } = require('socket.io');
const { randomBytes, randomUUID } = require("node:crypto");
const app = express();
const server = createServer(app);
const ALLOWED_ORIGINS = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.137.1:3000"
  ]);

const io = new Server(server, {
  maxHttpBufferSize: 16 * 1024,
  allowRequest: (request, callback) => {
    const origin = request.headers.origin;
    const allowed = !origin || ALLOWED_ORIGINS.has(origin);

    if (!allowed) {
      console.log(`SECURITY: rejected origin ${origin}`);
    }
    callback(
      null,
      allowed
    );
  }
});

const MAX_USERNAME_LENGTH = 30;
const MAX_ROOM_LENGTH = 64;
const MAX_CIPHERTEXT_LENGTH = 8192;
const RATE_WINDOW_MS = 7_000;
const MAX_MESSAGES_PER_WINDOW = 10;
const USERNAME_PATTERN = /^[A-Za-z0-9 _-]+$/;
const ROOM_PATTERN = /^[A-Za-z0-9_-]+$/;

app.use(express.static(path.join(__dirname, "public")));

const roomSalts = new Map();
let tamperNextMessage = false;
let forgeSenderNext = false;
const lastPackets = new Map();
const dropNextByRoom = new Set();

function isRateLimited(socket) {
  const now = Date.now();
  const recentMessages = (socket.data.messageTimes ?? [] ).filter(timestamp => timestamp > now - RATE_WINDOW_MS);

  if (recentMessages.length >= MAX_MESSAGES_PER_WINDOW) {
    socket.data.messageTimes = recentMessages;
    return true;
  }
  recentMessages.push(now);
  socket.data.messageTimes = recentMessages;

  return false;
}

io.on('connection', (socket)=>{
  console.log("Connected:", socket.id);
  socket.data.messageTimes = [];

  socket.on("join-room", ({ username, room }, acknowledge) => {
    const cleanUsername = typeof username === "string" ? username.trim() : "";
    const cleanRoom = typeof room === "string" ? room.trim() : "";

    if (!cleanUsername || !cleanRoom ||
      cleanUsername.length > MAX_USERNAME_LENGTH ||
      cleanRoom.length > MAX_ROOM_LENGTH ||
      !USERNAME_PATTERN.test(cleanUsername) ||
      !ROOM_PATTERN.test(cleanRoom)) {
      acknowledge({
        ok: false,
        error:"Invalid username or room name"
      });

      return;
    }


    socket.data.username = cleanUsername;
    socket.data.room = cleanRoom;

    socket.on("arm-tamper", acknowledge => {
      tamperNextMessage = true;
      console.log("ATTACK LAB: next ciphertext will be modified");
      if (typeof acknowledge === "function") {
        acknowledge({
          ok: true
        });
      }
    });

    socket.on("arm-forgery", acknowledge => {
      forgeSenderNext = true;
      console.log("ATTACK LAB: next sender name will be forged");

      if (typeof acknowledge === "function") {
        acknowledge({
          ok: true
        });
      } 
    });

    socket.on("arm-drop", acknowledge => {
      const room = socket.data.room;

      if (!room) {
        if (typeof acknowledge === "function") {
          acknowledge({
            ok: false,
            error: "Join a room before arming the attack."
          });
        }
        return;
      }

      dropNextByRoom.add(room);

      console.log(`ATTACK LAB: next message in ${room} will be dropped`);

      if (typeof acknowledge === "function") {
        acknowledge({
          ok: true
        });
      }
    });

    socket.on("replay-last", acknowledge => {
      const room = socket.data.room;
      const packet = lastPackets.get(room);

      if (!room || !packet) {
        if (typeof acknowledge ==="function") {
          acknowledge({
            ok: false,
            error: "No encrypted packet is available to replay."
          });
        }
        return;
      }
      console.log("ATTACK LAB: replaying old valid packet");

      io.to(room).emit(
        "encrypted-message",
        packet
      );

      if (typeof acknowledge === "function") {
        acknowledge({
          ok: true
        });
      } 
    });

    socket.data.username = username.trim();
    socket.data.room = room.trim();

    socket.join(socket.data.room);

    if (!roomSalts.has(socket.data.room)) {
      roomSalts.set(
        socket.data.room,
        randomBytes(16).toString("base64")
      );
    }

    acknowledge({
      ok: true,
      username: socket.data.username,
      room: socket.data.room
    });

    socket.emit("room-ready", {
      room: socket.data.room,
      salt: roomSalts.get(socket.data.room)
    });

    socket.to(socket.data.room).emit("user-joined", {
      username: socket.data.username,
      room: socket.data.room,
      joinedAt: Date.now()
    });

    console.log( `${socket.data.username} joined ${socket.data.room}`);
  });
  
  socket.on( "encrypted-message", (packet, acknowledge) => {
      const sendAcknowledgement = response => {
        if ( typeof acknowledge === "function") {
          acknowledge(response);
        }
      };

      const ivByteLength = typeof packet?.iv === "string" ? Buffer.from(packet.iv, "base64").length : 0;
      if (
        !packet ||
        typeof packet !== "object" ||
        packet.version !== 1 ||
        typeof packet.room !== "string" ||
        typeof packet.sender !== "string" ||
        typeof packet.iv !== "string" ||
        typeof packet.ciphertext !== "string" ||
        typeof packet.messageId !== "string" ||
        !Number.isSafeInteger(packet.sequence) ||
        packet.sequence < 1 || 
        !Number.isFinite(packet.sentAt) ||
        packet.room.length > MAX_ROOM_LENGTH ||
        packet.sender.length > MAX_USERNAME_LENGTH ||
        packet.messageId.length > 64 ||
        packet.ciphertext.length > MAX_CIPHERTEXT_LENGTH ||
        ivByteLength !== 12
      ) {
        console.log("SECURITY: rejected malformed or oversized encrypted packet");
        sendAcknowledgement({
          ok: false,
          error:"Malformed or oversized encrypted packet"
        });

        return;
      }



      if (
        packet.room !== socket.data.room ||
        packet.sender !== socket.data.username || !socket.rooms.has(packet.room)
      ) {
        console.log("Rejected unauthorised encrypted packet");
        sendAcknowledgement({
          ok: false,
          error:"You are not authorised to send to this room"
        });

        return;
      }

      console.log(`CIPHERTEXT from ${packet.sender}:`, packet.ciphertext.slice(0, 80));
      
      let outgoingPacket = {
        ...packet
      };

      if (isRateLimited(socket)) {
        console.log(`SECURITY: rate limit triggered for ${socket.id}`);
        sendAcknowledgement({
          ok: false,
          error: "Too many messages. Wait a few seconds."
        });

        return;
      }

      if (tamperNextMessage) {
        const ciphertextBytes = Buffer.from(outgoingPacket.ciphertext,"base64");
        if (ciphertextBytes.length > 0) {
          ciphertextBytes[0] ^= 1;
        }
        outgoingPacket.ciphertext = ciphertextBytes.toString("base64");
        tamperNextMessage = false;

        console.log("ATTACK LAB: ciphertext byte modified");
      }

      if (forgeSenderNext) {
        outgoingPacket.sender = "Course Admin";
        forgeSenderNext = false;
        console.log("ATTACK LAB: sender metadata forged");
      }

      if (dropNextByRoom.has(socket.data.room)) {
        dropNextByRoom.delete(socket.data.room);
        console.log(`ATTACK LAB: encrypted message ${packet.messageId} silently dropped`);

        sendAcknowledgement({
          ok: true,
          id: packet.messageId
        });

        return;
      }
      
      lastPackets.set(socket.data.room, outgoingPacket);

      io.to(socket.data.room).emit(
        "encrypted-message",
        outgoingPacket
      );
      sendAcknowledgement({
        ok: true,
        id: packet.messageId
      });
    }
  );



  // socket.on("chat-message", ({ room, message }, acknowledge) => {
  //   if (
  //     typeof room !== "string" ||
  //     typeof message !== "string" ||
  //     !message.trim()

  //   ) {
  //     acknowledge({
  //       ok: false,
  //       error: "Invalid message"
  //     });

  //     return;
  //   }

  //   if (!socket.rooms.has(room)) {
  //     console.log("Rejected message for unauthorised room");
  //     return;
  //   }

  //   const packet = {
  //     id: randomUUID(),
  //     sender: socket.data.username ?? "Unknown",
  //     message: message.trim(),
  //     sentAt: Date.now()
  //   };

  //   console.log(
  //     `PLAINTEXT from ${packet.sender}:`,
  //     message
  //   );

  //   io.to(room).emit("chat-message", packet);

  //   acknowledge({
  //     ok: true,
  //     id: packet.id
  //   });
  // });

  socket.on("disconnect", () => {
    const username = socket.data.username;
    const room = socket.data.room;

    console.log("Disconnected:", socket.id);
    if (username && room) {
      socket.to(room).emit("user-left", {
        username,
        room,
        leftAt: Date.now()
      });
    }
  });
});

server.listen(3000, () =>{
  console.log('server is running at http://localhost:3000');
});