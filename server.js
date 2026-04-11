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

// Routes
app.use('/api/room', roomRoutes);
app.use('/api/auth', authRoutes);

// File Upload Route
app.post('/api/chat/upload', protect, upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const imageUrl = process.env.CLOUDINARY_URL ? req.file.path : `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ imageUrl });
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

// Keep-awake ping for Render
setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || 'https://okaaz-server.onrender.com';
    fetch(`${url}/`).catch(() => {});
}, 10 * 60 * 1000); 
