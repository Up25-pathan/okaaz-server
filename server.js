import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { createServer } from 'http';
import roomRoutes from './routes/room.js';
import authRoutes, { protect } from './routes/auth.js';
import Message from './models/Message.js';
import User from './models/User.js';
import Group from './models/Group.js';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const httpServer = createServer(app);

// Multer Storage Configuration
let storage;
if (process.env.CLOUDINARY_URL) {
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'okaaz_chat',
      allowed_formats: ['jpg', 'png', 'jpeg', 'gif', 'mp4', 'mov', 'webm'],
      resource_type: 'auto',
    },
  });
  console.log("✓ Cloudinary storage configured successfully.");
} else {
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
  }
  storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
  });
  console.log("⚠ WARNING: Local disk storage enabled. Images will wipe on Render restart. Add CLOUDINARY_URL.");
}
const upload = multer({ storage: storage });

const io = new Server(httpServer, {
  cors: {
    origin: '*',
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const onlineUsers = new Map();

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

    // Reply and Reaction Handling
    socket.on('add_reaction', async (data) => {
        // data: { messageId, userId, emoji, roomId }
        try {
            const message = await Message.findById(data.messageId);
            if (message) {
                // Check if user already reacted with this emoji
                const existing = message.reactions.find(r => r.userId.toString() === data.userId && r.emoji === data.emoji);
                if (existing) {
                    // Toggle off (remove)
                    message.reactions = message.reactions.filter(r => r._id !== existing._id);
                } else {
                    // Add reaction
                    message.reactions.push({ userId: data.userId, emoji: data.emoji });
                }
                await message.save();
                io.to(data.roomId).emit('message_reaction_updated', {
                    messageId: message._id,
                    reactions: message.reactions
                });
            }
        } catch (e) {
            console.error('Error adding reaction:', e);
        }
    });

    socket.on('send_message', async (messageData) => {
        try {
            // messageData includes { channel, text, type, mediaUrl, replyTo, sender }
            const newMessage = new Message(messageData);
            await newMessage.save();

            // Populate sender and replyTo details for the broadcast
            await newMessage.populate([
                { path: 'sender', select: 'username email avatarUrl' },
                { path: 'replyTo', populate: { path: 'sender', select: 'username' } }
            ]);

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
app.get('/api/chat/history', protect, async (req, res) => {
    try {
        const { channel } = req.query;
        if (!channel) return res.status(400).json({ error: 'Channel is required' });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Privacy Check: If it's a DM, ensure the requesting user is a participant
        if (channel.startsWith('dm_')) {
            const participants = channel.replace('dm_', '').split('_');
            if (!participants.includes(req.user._id.toString())) {
                return res.status(403).json({ error: 'Access denied: You are not a participant in this DM.' });
            }
        }

        const messages = await Message.find({ channel })
            .sort({ createdAt: -1 }) // get newest messages
            .skip(skip)
            .limit(limit)
            .populate('sender', 'username email avatarUrl')
            .populate({ path: 'replyTo', populate: { path: 'sender', select: 'username' } });
        
        // Reverse array to put old messages at the top for UI
        res.json(messages.reverse());
    } catch (error) {
        console.error('History fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history' });
    }
});

// Fetch active DM conversations for the current user
app.get('/api/chat/conversations', protect, async (req, res) => {
    try {
        const userIdStr = req.user._id.toString();
        const dmRegex = new RegExp(`^dm_.*${userIdStr}.*`);
        
        const conversations = await Message.aggregate([
            { $match: { channel: { $regex: dmRegex } } },
            { $sort: { createdAt: -1 } },
            { 
                $group: { 
                    _id: '$channel',
                    latestMessage: { $first: '$$ROOT' }
                }
            },
            { $sort: { 'latestMessage.createdAt': -1 } }
        ]);

        const populatedConversations = [];
        for (const convo of conversations) {
            const participants = convo._id.replace('dm_', '').split('_');
            const peerId = participants.find(id => id !== userIdStr);
            
            if (peerId) {
                const peerUser = await User.findById(peerId).select('username avatarUrl email');
                if (peerUser) {
                    populatedConversations.push({
                        channel: convo._id,
                        peerUser: peerUser,
                        latestMessage: convo.latestMessage
                    });
                }
            }
        }

        res.json(populatedConversations);
    } catch (error) {
        console.error('Conversations fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch conversations' });
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

// Fetch groups where the current user is a member
app.get('/api/group/mine', protect, async (req, res) => {
    try {
        const groups = await Group.find({ members: req.user._id });
        res.json(groups);
    } catch (error) {
        console.error('Fetch mine groups error:', error);
        res.status(500).json({ error: 'Failed to fetch your groups' });
    }
});

// Create a new group
app.post('/api/group/create', protect, async (req, res) => {
    try {
        const { name, description, profileUrl, isAnnouncementOnly } = req.body;
        if (!name) return res.status(400).json({ error: 'Group name is required' });

        const groupId = `group_${Date.now()}`;
        const newGroup = await Group.create({
            groupId,
            name,
            description,
            profileUrl,
            isAnnouncementOnly: isAnnouncementOnly || false,
            members: [req.user._id],
            admins: [req.user._id],
            createdBy: req.user._id
        });

        res.status(201).json(newGroup);
    } catch (error) {
        console.error('Create group error:', error);
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// Group Details Endpoint
app.get('/api/group/:id', protect, async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id });
        if (!group) return res.status(404).json({ error: 'Group not found' });
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch group info' });
    }
});

// Update Group Endpoint
app.patch('/api/group/:id', protect, async (req, res) => {
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

app.post('/api/chat/upload', protect, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  let imageUrl;
  if (process.env.CLOUDINARY_URL) {
      imageUrl = req.file.path; // Cloudinary secure URL
  } else {
      imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  }
  res.json({ imageUrl });
});

// Keep-awake ping for Render free tier
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL || 'https://okaaz-server.onrender.com';
  fetch(url).catch(() => {});
}, 14 * 60 * 1000); // Ping every 14 minutes

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
