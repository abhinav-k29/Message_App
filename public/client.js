const socket = io();
// most important client side code above

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let aesKey = null;
let roomSalt = "";
let sendSequence = 0;

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

const passphraseInput =
  document.querySelector("#passphrase");

const setKeyButton =
  document.querySelector("#set-key");

const keyStatus =
  document.querySelector("#key-status");

const fingerprintText =
  document.querySelector("#fingerprint");

let currentRoom = "";
let currentUsername = "";

socket.on("connect", () => {
  console.log("Connected:", socket.id);
  statusText.textContent =`Connected: ${socket.id}. Join a room.`;
});

function bytesToBase64(value) {
  const bytes =
    value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}

function formatFingerprint(buffer) {
  const bytes =
    Array.from(new Uint8Array(buffer).slice(0, 8));

  const hexadecimal = bytes
    .map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join("");

  return hexadecimal.match(/.{1,4}/g).join("-");
}

async function deriveRoomKey(
  passphrase,
  saltBase64
) {
  const passphraseBytes =
    encoder.encode(passphrase);

  const keyMaterial =
    await crypto.subtle.importKey(
      "raw",
      passphraseBytes,
      "PBKDF2",
      false,
      ["deriveBits"]
    );

  const keyBits =
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: base64ToBytes(saltBase64),
        iterations: 600000,
        hash: "SHA-256"
      },
      keyMaterial,
      256
    );

  aesKey =
    await crypto.subtle.importKey(
      "raw",
      keyBits,
      {
        name: "AES-GCM"
      },
      false,
      ["encrypt", "decrypt"]
    );

  const fingerprintHash =
    await crypto.subtle.digest(
      "SHA-256",
      keyBits
    );

  return formatFingerprint(fingerprintHash);
}



function displaySystemMessage(
  text,
  timestamp
) {
  const item = document.createElement("li");
  const time = new Date(timestamp).toLocaleTimeString();

  item.textContent =`[${time}] ${text}`;
  item.classList.add("system-message");
  messagesList.appendChild(item);
}

joinButton.addEventListener("click", () => {
  const username = usernameInput.value.trim();
  const room = roomInput.value.trim();

  if (!username || !room) {
    statusText.textContent = "Enter both a username and room.";
    return;
  }

  statusText.textContent = "Joining room...";

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
      statusText.textContent = response?.error ?? "Could not join room.";
      return;
    }
  
    currentUsername = response.username;
    currentRoom = response.room;


    // new room should need new encyrption key
    aesKey = null;
    roomSalt = "";
    sendSequence = 0;

    fingerprintText.textContent = "Not available";
    keyStatus.textContent = "Encryption key not created";
    statusText.textContent = `${username} joined room ${room}`;
    }
  );

});

async function encryptMessage(message) {
  if (!aesKey) {
    throw new Error(
      "Encryption key has not been created."
    );
  }
  const iv =crypto.getRandomValues(new Uint8Array(12));
  const plaintextBytes = encoder.encode(message);

  const encryptedBuffer =
    await crypto.subtle.encrypt({ name: "AES-GCM", iv },
      aesKey,
      plaintextBytes
    );
  sendSequence += 1;

  return {
    version: 1,
    room: currentRoom,
    sender: currentUsername,
    messageId: crypto.randomUUID(),
    sequence: sendSequence,
    sentAt: Date.now(),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(encryptedBuffer)
  };
}

async function decryptMessage(packet) {
  if (!aesKey) {
    throw new Error(
      "Encryption key has not been created."
    );
  }
  const iv = base64ToBytes(packet.iv);
  const ciphertext =base64ToBytes(packet.ciphertext);

  const plaintextBuffer =
    await crypto.subtle.decrypt({name: "AES-GCM", iv},
      aesKey,
      ciphertext
    );

  // Convert decrypted UTF-8 byte back into javascript string
  return decoder.decode(
    plaintextBuffer
  );
}

socket.on(
  "room-ready",
  ({ room, salt }) => {
    roomSalt = salt;

    statusText.textContent =
      `You joined ${room}. Enter the shared passphrase to create the encryption key.`;
  }
);

socket.on(
  "user-joined",
  ({ username, room, joinedAt }) => {
    displaySystemMessage(
      `${username} joined room ${room}`,
      joinedAt
    );
  }
);

setKeyButton.addEventListener("click", async () => {
    const passphrase =
      passphraseInput.value;

    if(!currentRoom || !roomSalt){
      keyStatus.textContent = "Join a room first.";
      return;
    }

    if(!passphrase){
      keyStatus.textContent = "Enter the shared passphrase.";
      return;
    }

    try {
      keyStatus.textContent = "Deriving key...";

      const fingerprint =
        await deriveRoomKey(
          passphrase,
          roomSalt
        );
      fingerprintText.textContent = fingerprint;

      keyStatus.textContent = "Encryption key ready.";
    } catch (error) {
      console.error(error);

      keyStatus.textContent = "Key derivation failed.";
    }
  }
);

sendButton.addEventListener("click", async () => {
  const message = messageInput.value.trim();

  if (!currentRoom) {
    statusText.textContent = "Join a room before sending.";
    return;
  }

  if (!message) {
    return;
  }

  if (!aesKey) {
    statusText.textContent = "Create the encryption key first.";
    return;
  }

  try{
    const packet = await encryptMessage(message);

    socket.timeout(5000).emit("encrypted-message", packet,
      (error, response) => {
        if (error) {
          statusText.textContent = "The server did not acknowledge the encrypted message.";
          return;
        }
        if (!response.ok) {
          statusText.textContent = response.error ?? "Encrypted Message failed";
          return;
        }
        statusText.textContent = `Encrypted message accepted: ${response.id}`;
        messageInput.value = "";
      }
    );
  } 
  catch (error) {
    console.error("Encryption error:", error);
    statusText.textContent = "Encryption failed.";
  }

});

socket.on(
  "encrypted-message",
  async packet => {
    const item = document.createElement("li");
    const time = new Date(packet.sentAt).toLocaleTimeString();

    try {
      const message =  await decryptMessage(packet);

      item.textContent = `[${time}] ${packet.sender}: ${message}`;
    } catch (error) {
      console.error("Decryption error:", error);
      item.textContent =`[${time}] ⚠ Message authentication failed. ` + `The key is wrong or the encrypted packet was altered.`;
      item.classList.add("security-error");
    }

    messagesList.appendChild(item);
  }
);

socket.on(
  "user-left",
  ({ username, room, leftAt }) => {
    displaySystemMessage(
      `${username} left room ${room}`,
      leftAt
    );
  }
);