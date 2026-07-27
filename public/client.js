const socket = io();
// most important client side code above
const usernameInput =
  document.querySelector("#username");

const roomInput =
  document.querySelector("#room");

const messageInput =
  document.querySelector("#message");

const messagesList =
  document.querySelector("#messages");

const statusText =
  document.querySelector("#status");

const joinButton =
  document.querySelector("#join");

const sendButton =
  document.querySelector("#send");

let currentRoom = "";
let currentUsername = "";

joinButton.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const room = roomInput.value.trim();

  if (!username || !room) {
    statusText.textContent = "Enter both a username and room.";
    return;
  }

  socket.timeout(5000).emit("join-room", {
    username,
    room
    },
    (error, response) => {
    if (error) {
      statusText.textContent = "Server did not respond in time";
      return;
    }

    if (!response.ok) {
      statusText.textContent = response.error;
      return;
    }}
  );

  currentUsername = username;
  currentRoom = room;

  statusText.textContent = `${username} joined room ${room}`;
});

sendButton.addEventListener("click", () => {
  const message = messageInput.value.trim();

  if (!currentRoom) {
    statusText.textContent = "Join a room before sending.";
    return;
  }

  if (!message) {
    return;
  }

  socket.emit("chat-message", {
    room: currentRoom,
    message
    },
    (response) => {
    if (!response.ok) {
      statusText.textContent =
        response.error ?? "Message failed";

      return;
    }
    statusText.textContent = `Message accepted: ${response.id}`;
    }
  );

  messageInput.value = "";
});

socket.on(
  "chat-message",
  ({ sender, message, sentAt }) => {
    const item = document.createElement("li");

    const time = new Date(sentAt)
      .toLocaleTimeString();
    item.textContent =
      `[${time}] ${sender}: ${message}`;

    messagesList.appendChild(item);
  }
);