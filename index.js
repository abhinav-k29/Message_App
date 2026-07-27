const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const path = require("path");
const { Server } = require('socket.io');
const crypto = require("node:crypto");
const app = express();
const server = createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));



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

    acknowledge({
      ok: true,
      username: socket.data.username,
      room: socket.data.room
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
      message: packet.message
    });
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

server.listen(3000, () =>{
  console.log('server is running at local host 3000');
});