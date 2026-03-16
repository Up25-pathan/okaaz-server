import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { AccessToken } from 'livekit-server-sdk';
import mongoose from 'mongoose';
import roomRoutes from './routes/room.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

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

// Database Connection
let mongodbUri = process.env.MONGODB_URI;
if (mongodbUri) {
  // Clean common copy-paste errors (like including 'const uri = ' or quotes)
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
  res.json({ message: 'MEET API is running' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
