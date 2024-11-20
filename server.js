const express = require("express");
const { createServer } = require("http");
const path = require("path");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const { Doc, applyUpdate, encodeStateAsUpdate } = require("yjs");
const ACTIONS = require("./src/actions/Actions");

const { Schema, model } = mongoose;

// Initialize Express app and HTTP server
const app = express();
const server = createServer(app);

// Set up WebSocket communication using Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

// Serve static files (for frontend) in production
app.use(express.static("build"));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

// Database connection and schema definition
const MONGO_URI =
  "mongodb+srv://raimudit2003:45rZe44zK4LM9lgm@cluster0.gzqnu3c.mongodb.net/?retryWrites=true&w=majority";
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const CodeSchema = new Schema({
  room: String,
  content: String,
  lastUpdated: { type: Date, default: Date.now },
});
const Code = model("Code", CodeSchema);

const userSocketMap = {}; // Map for tracking users
const rooms = new Map(); // Map to store Y.js documents and intervals

// Helper to get all connected clients in a room
function getAllConnectedClients(roomId) {
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    (socketId) => ({
      socketId,
      username: userSocketMap[socketId],
    })
  );
}

// Save room data periodically to the database
async function saveRoomToDatabase(roomId) {
  const roomData = rooms.get(roomId);
  if (roomData) {
    const { ydoc } = roomData;
    const content = ydoc.getText("codemirror").toString();

    try {
      await Code.findOneAndUpdate(
        { room: roomId },
        { content, lastUpdated: new Date() },
        { upsert: true, new: true }
      );
      console.log(`Room ${roomId} content saved to MongoDB.`);
    } catch (err) {
      console.error(`Error saving room ${roomId} to MongoDB:`, err);
    }
  }
}

// Socket.IO communication handlers
io.on("connection", (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on(ACTIONS.JOIN, async ({ roomId, username }) => {
    console.log(`${username} is joining room: ${roomId}`);
    userSocketMap[socket.id] = username;
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      const ydoc = new Doc();
      rooms.set(roomId, { ydoc });

      try {
        const existingDoc = await Code.findOne({ room: roomId });
        if (existingDoc) {
          ydoc.getText("codemirror").insert(0, existingDoc.content);
          console.log(`Loaded existing content for room ${roomId}`);
        }

        const interval = setInterval(
          () => saveRoomToDatabase(roomId),
          5 * 60 * 1000 // Save every 5 minutes
        );
        rooms.get(roomId).interval = interval;
      } catch (err) {
        console.error(`Error fetching room ${roomId} data from MongoDB:`, err);
      }
    }

    const clients = getAllConnectedClients(roomId);
    console.log("Clients in room:", clients);

    clients.forEach(({ socketId }) => {
      io.to(socketId).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
      });
    });

    const { ydoc } = rooms.get(roomId);
    socket.emit(ACTIONS.CODE_CHANGE, {
      code: ydoc.getText("codemirror").toString(),
    });
  });

  socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
    const roomData = rooms.get(roomId);
    if (roomData) {
      const { ydoc } = roomData;
      ydoc.getText("codemirror").delete(0, ydoc.getText("codemirror").length);
      ydoc.getText("codemirror").insert(0, code);

      socket.to(roomId).emit(ACTIONS.CODE_CHANGE, { code });
    }
  });

  socket.on(ACTIONS.SYNC_CODE, ({ roomId, code }) => {
    socket.emit(ACTIONS.CODE_CHANGE, { code });
  });

  socket.on("disconnecting", () => {
    const rooms = Array.from(socket.rooms).filter((roomId) => roomId !== socket.id);

    rooms.forEach((roomId) => {
      const clients = getAllConnectedClients(roomId);
      const username = userSocketMap[socket.id];

      socket.to(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username,
      });

      if (clients.length === 1) {
        saveRoomToDatabase(roomId).then(() => {
          delete rooms[roomId];
          console.log(`Room ${roomId} saved and deleted.`);
        });
      }
    });

    delete userSocketMap[socket.id];
  });
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  for (const roomId of rooms.keys()) {
    await saveRoomToDatabase(roomId);
    clearInterval(rooms.get(roomId).interval);
  }
  process.exit();
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running on http://localhost:${PORT}`)
);
