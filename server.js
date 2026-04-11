import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

// Modular Imports
import connectDB from './config/db.js';
import { setupSocket, getOnlineUsers } from './sockets/socketHandler.js';
import roomRoutes from './routes/room.js';
import authRoutes, { protect } from './routes/auth.js';
import Group from './models/Group.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Multer & Cloudinary Initialization
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
    console.log("✓ Cloudinary storage configured.");
} else {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
    });
    console.log("⚠ WARNING: Local storage enabled.");
}
const upload = multer({ storage });

// Socket Initialization
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ["GET", "POST"] },
    pingTimeout: 60000,
});
setupSocket(io);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Health & Status Routes
app.get('/', (req, res) => {
    const dbStatus = mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected';
    res.json({ 
        status: 'OK',
        service: 'OKAAZ Backend',
        database: dbStatus,
        socketConnections: io.engine.clientsCount
    });
});

app.get('/api/ping', (req, res) => {
    res.status(200).send('pong');
});

// Routes
app.use('/api/room', roomRoutes);
app.use('/api/auth', authRoutes);

// File Upload Route
app.post('/api/chat/upload', protect, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const imageUrl = process.env.CLOUDINARY_URL ? req.file.path : `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ imageUrl });
});

// Chat History Endpoint
import Message from './models/Message.js';

app.get('/api/chat/history', protect, async (req, res) => {
    try {
        const { channel } = req.query;
        if (!channel) return res.status(400).json({ error: 'Channel is required' });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        if (channel.startsWith('dm_')) {
            const participants = channel.replace('dm_', '').split('_');
            if (!participants.includes(req.user._id.toString())) {
                return res.status(403).json({ error: 'Access denied.' });
            }
        }

        const messages = await Message.find({ channel })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('sender', 'username email avatarUrl')
            .populate({ path: 'replyTo', populate: { path: 'sender', select: 'username' } });
        
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
        
        const populatedConversations = await Message.aggregate([
            { $match: { channel: { $regex: dmRegex } } },
            { $sort: { createdAt: -1 } },
            { $group: { _id: '$channel', latestMessage: { $first: '$$ROOT' } } },
            { $addFields: { participants: { $split: ["$_id", "_"] } } },
            { $addFields: {
                peerId: {
                    $filter: {
                        input: "$participants",
                        as: "p",
                        cond: { $and: [{ $ne: ["$$p", "dm"] }, { $ne: ["$$p", userIdStr] }] }
                    }
                }
            }},
            { $unwind: "$peerId" },
            { $addFields: { peerObjectId: { $toObjectId: "$peerId" } } },
            { $lookup: { from: 'users', localField: 'peerObjectId', foreignField: '_id', as: 'peerUser' } },
            { $unwind: "$peerUser" },
            { $project: {
                channel: "$_id",
                latestMessage: 1,
                peerUser: { username: 1, avatarUrl: 1, email: 1, _id: 1 }
            }},
            { $sort: { 'latestMessage.createdAt': -1 } }
        ]);

        res.json(populatedConversations);
    } catch (error) {
        console.error('Conversations fetch error:', error);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

// Presence API
app.get('/api/user/:id/presence', (req, res) => {
    const targetUserId = req.params.id;
    const onlineUsers = getOnlineUsers();
    let isOnline = false;
    for (const [_, user] of onlineUsers.entries()) {
        if (user.userId.toString() === targetUserId) {
            isOnline = true;
            break;
        }
    }
    res.json({ isOnline, lastSeen: new Date() });
});

// Server Initialization Logic
const initializeGroups = async () => {
    const defaults = [
        { groupId: 'general', name: 'General Discussion', description: 'Open community chat.', isPublic: true },
        { groupId: 'announcement', name: 'Official Announcements', description: 'Updates for OKAAZ.', isPublic: true, isAnnouncementOnly: true }
    ];
    for (const d of defaults) {
        await Group.findOneAndUpdate({ groupId: d.groupId }, { $set: d }, { upsert: true, new: true });
    }
    console.log("✓ Default groups synchronized.");
};

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await connectDB();
    if (mongoose.connection.readyState === 1) await initializeGroups();
});

// Keep-awake ping for Render (Self-ping every 5 minutes)
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://okaaz-server.onrender.com';
    fetch(`${url}/api/ping`)
        .then(res => console.log(`[${new Date().toISOString()}] Self-ping success: ${res.status}`))
        .catch(err => console.error(`[${new Date().toISOString()}] Self-ping failed: ${err.message}`));
}, 5 * 60 * 1000); 
