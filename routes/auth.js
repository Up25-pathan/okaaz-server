import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import dotenv from 'dotenv';

dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_super_secret_key_change_this';

// Auth Middleware
export const protect = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'No token provided' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId).select('-password');
        
        if (!user) return res.status(401).json({ error: 'User not authorized' });
        
        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

// Register
router.post('/register', async (req, res) => {
    try {
        const { username, email, password, inviteCode } = req.body;

        // Simple Invite Code Check
        const GROUP_INVITE_CODE = process.env.INVITE_CODE || 'OKAAZ-2024'; 
        const ADMIN_INVITE_CODE = 'OKAAZ-ADMIN';

        let role = 'user';
        if (inviteCode === ADMIN_INVITE_CODE) {
            role = 'admin';
        } else if (inviteCode !== GROUP_INVITE_CODE) {
            return res.status(403).json({ error: 'Invalid invite code. Access restricted.' });
        }

        // Check if user exists
        const existingUser = await User.findOne({ $or: [{ email }, { username }] });
        if (existingUser) {
            return res.status(400).json({ error: 'Username or email already exists' });
        }

        const user = new User({ username, email, password, role });
        await user.save();

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.status(201).json({ token, user: { _id: user._id, username, email, avatarUrl: user.avatarUrl, role: user.role } });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await User.findOne({ email });
        if (!user || !(await user.comparePassword(password))) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { _id: user._id, username: user.username, email, avatarUrl: user.avatarUrl, role: user.role } });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error during login' });
    }
});

// Get current user (protected)
router.get('/me', protect, async (req, res) => {
    res.json(req.user);
});

// Update Profile
router.put('/profile', protect, async (req, res) => {
    try {
        const { username, bio, avatarUrl } = req.body;

        const user = await User.findByIdAndUpdate(
            req.user._id,
            { username, bio, avatarUrl },
            { new: true }
        ).select('-password');

        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Get all members
router.get('/members', async (req, res) => {
    try {
        const users = await User.find().select('username avatarUrl bio createdAt');
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch members' });
    }
});

// Get specific user profile
router.get('/profile/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('username avatarUrl bio createdAt');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json(user);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' });
    }
});

export default router;
