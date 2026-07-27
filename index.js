const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const path = require("path");
const { Server } = require('socket.io');
const { randomBytes, randomUUID } = require("node:crypto");
const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

const roomSalts = new Map();

io.on('connection', (socket)=>{
  console.log("Connected:", socket.id);

  socket.on("join-room", ({ username, room }, acknowledge) => {
    if (
      typeof username !== "string" ||
      typeof room !== "string" ||
      !username?.trim() ||
      !room?.trim()
    ) {
      acknowledge({
        ok: false,
        error: "Username and room are required"
      });

      return;
    }

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
  
  socket.on("chat-message", ({ room, message }, acknowledge) => {
    if (
      typeof room !== "string" ||
      typeof message !== "string" ||
      !message.trim()

    ) {
      acknowledge({
        ok: false,
        error: "Invalid message"
      });

      return;
    }

    if (!socket.rooms.has(room)) {
      console.log("Rejected message for unauthorised room");
      return;
    }

    const packet = {
      id: randomUUID(),
      sender: socket.data.username ?? "Unknown",
      message: message.trim(),
      sentAt: Date.now()
    };

    console.log(
      `PLAINTEXT from ${packet.sender}:`,
      message
    );

    io.to(room).emit("chat-message", packet);

    acknowledge({
      ok: true,
      id: packet.id
    });
  });

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