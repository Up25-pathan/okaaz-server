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

  socket.on('send_message', async (data) => {
    try {
      const { senderId, text, type, mediaUrl, channel } = data;
      const targetChannel = channel || 'general';
      
      const newMessage = new Message({
        sender: senderId,
        text,
        type: type || 'text',
        mediaUrl: mediaUrl || '',
        channel: targetChannel,
      });
      await newMessage.save();

      const populatedMessage = await Message.findById(newMessage._id).populate('sender', 'username avatarUrl');
      io.to(targetChannel).emit('receive_message', populatedMessage);
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
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
    .then(() => console.log('Connected to MongoDB'))
    .catch((err) => console.error('MongoDB connection error:', err));
}

// Basic health check endpoint
app.get('/', (req, res) => {
  res.json({ message: 'OKAAZ API with Community Hub is running' });
});

// Chat History Endpoint
app.get('/api/chat/history', async (req, res) => {
    try {
        const { channel } = req.query;
        const query = channel ? { channel } : { channel: 'general' };
        
        const messages = await Message.find(query)
            .sort({ createdAt: -1 })
            .limit(50)
            .populate('sender', 'username avatarUrl');
        res.json(messages.reverse());
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch chat history' });
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
