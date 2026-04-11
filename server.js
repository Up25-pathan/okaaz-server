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
import roomRoutes, { setIO } from './routes/room.js';
import authRoutes, { protect } from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import chatRoutes from './routes/chat.js';
import Group from './models/Group.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);

// Socket Initialization
const io = new Server(httpServer, {
    cors: { origin: '*', methods: ["GET", "POST"] },
    pingTimeout: 60000,
});
setupSocket(io);
setIO(io);
app.set('io', io); // Make IO accessible in routes

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Routes
app.use('/api/room', roomRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/chat', chatRoutes);

// File Upload Route
app.post('/api/chat/upload', protect, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileUrl = process.env.CLOUDINARY_URL ? req.file.path : `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ 
        url: fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size
    });
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
