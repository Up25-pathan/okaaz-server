import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { createServer } from 'http';
import roomRoutes from './routes/room.js';
import authRoutes from './routes/auth.js';
import Message from './models/Message.js';
import User from './models/User.js';
import Group from './models/Group.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Multer Storage Configuration
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

const io = new Server(httpServer, {
  cors: {
    origin: '*',
  }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Request logger
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Routes
app.use('/api/room', roomRoutes);
app.use('/api/auth', authRoutes);

// Socket.io Logic
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join_channel', (channel) => {
    socket.join(channel);
    console.log(`Socket ${socket.id} joined channel: ${channel}`);
  });
    console.log(`User connected: ${socket.id}`);

    // Track user presence
    socket.on('user_connected', (userData) => {
        if (userData && userData._id) {
            onlineUsers.set(socket.id, {
                userId: userData._id,
                username: userData.username,
                lastSeen: new Date()
            });
            // Broadcast to everyone that this user is online
            io.emit('presence_update', { userId: userData._id, status: 'online' });
            console.log(`User ${userData.username} is online`);
        }
    });

    // Join a specific chat room (Hub Group or DM)
    socket.on('join_room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
    });

    socket.on('leave_room', (roomId) => {
        socket.leave(roomId);
        console.log(`User ${socket.id} left room: ${roomId}`);
    });

    // Typing Indicators
    socket.on('typing', (data) => {
        // data: { roomId: '...', userId: '...', username: '...' }
        socket.to(data.roomId).emit('user_typing', {
            userId: data.userId,
            username: data.username,
            roomId: data.roomId
        });
    });

    socket.on('stop_typing', (data) => {
        socket.to(data.roomId).emit('user_stopped_typing', {
            userId: data.userId,
            roomId: data.roomId
        });
    });

    socket.on('send_message', async (messageData) => {
        try {
            // messageData includes { channel, text, type, mediaUrl, sender: { _id, username, avatarUrl } }
            const newMessage = new Message(messageData);
            await newMessage.save();

            // Populate sender details for the broadcast
            await newMessage.populate('sender', 'username email avatarUrl');

            // Broadcast only to the specific room/channel
            const room = messageData.channel;
            io.to(room).emit('receive_message', newMessage);
        } catch (error) {
            console.error('Error saving message:', error);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        const user = onlineUsers.get(socket.id);
        if (user) {
            // Broadcast offline status with last seen
            io.emit('presence_update', { 
                userId: user.userId, 
                status: 'offline',
                lastSeen: new Date()
            });
            onlineUsers.delete(socket.id);
        }
    });
});

// Database Connection
let mongodbUri = process.env.MONGODB_URI;
if (mongodbUri) {
  mongodbUri = mongodbUri.trim();
  if (mongodbUri.startsWith('const uri = ')) {
    mongodbUri = mongodbUri.replace('const uri = ', '').trim();
  }
  if ((mongodbUri.startsWith('"') && mongodbUri.endsWith('"')) || 
      (mongodbUri.startsWith("'") && mongodbUri.endsWith("'"))) {
    mongodbUri = mongodbUri.substring(1, mongodbUri.length - 1);
  }

  mongoose.connect(mongodbUri)
    .then(() => {
      console.log('Connected to MongoDB');
      initializeGroups();
    })
    .catch((err) => console.error('MongoDB connection error:', err));
}

// Group Initialization
async function initializeGroups() {
  const defaultGroups = [
    {
      groupId: 'announcement',
      name: 'Official Announcements',
      description: 'The primary source for all OKAAZ updates, news, and official announcements. Stay tuned here!',
      profileUrl: 'https://images.unsplash.com/photo-1557683316-973673baf926?q=80&w=200&auto=format&fit=crop', // Professional abstract gradient
      isAnnouncementOnly: true,
    },
    {
      groupId: 'general',
      name: 'General Discussion',
      description: 'The heart of our community. Chat freely, introduce yourself, and connect with other members!',
      profileUrl: 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?q=80&w=200&auto=format&fit=crop', // Community/Collaborative image
      isAnnouncementOnly: false,
    }
  ];

  for (const groupData of defaultGroups) {
    const exists = await Group.findOne({ groupId: groupData.groupId });
    if (!exists) {
      await Group.create(groupData);
      console.log(`Default group initialized: ${groupData.name}`);
    }
  }
}

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'OKAAZ API with Community Hub is running' });
});

// Chat History Endpoint
// Fetch history for a specific room (Hub Group or DM)
app.get('/api/chat/history', async (req, res) => {
    try {
        const { channel } = req.query;
        if (!channel) return res.status(400).json({ error: 'Channel is required' });

        const messages = await Message.find({ channel })
            .sort({ createdAt: 1 })
            .populate('sender', 'username email avatarUrl');
        res.json(messages);
    } catch (error) {
        console.error('History fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// Presence endpoint to check a specific user's status
app.get('/api/user/:id/presence', async (req, res) => {
    try {
        const targetUserId = req.params.id;
        let isOnline = false;
        let lastSeen = null;

        // Check if user is currently in the onlineUsers map
        for (const [socketId, user] of onlineUsers.entries()) {
            if (user.userId.toString() === targetUserId) {
                isOnline = true;
                break;
            }
        }

        res.json({ isOnline, lastSeen: new Date() }); // In a real app, lastSeen would be pulled from User model if offline
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch presence' });
    }
});

// Group Details Endpoint
app.get('/api/group/:id', async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id });
        if (!group) return res.status(404).json({ error: 'Group not found' });
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch group info' });
    }
});

// Update Group Endpoint
app.patch('/api/group/:id', async (req, res) => {
    try {
        const { name, description, profileUrl } = req.body;
        const group = await Group.findOneAndUpdate(
            { groupId: req.params.id },
            { $set: { name, description, profileUrl } },
            { new: true }
        );
        if (!group) return res.status(404).json({ error: 'Group not found' });
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update group info' });
    }
});

app.post('/api/chat/upload', upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ imageUrl });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
