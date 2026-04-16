import express from 'express';
import { protect, admin } from '../utils/authMiddleware.js';
import User from '../models/User.js';
import Message from '../models/Message.js';
import Room from '../models/Room.js';
import bcrypt from 'bcryptjs';

const router = express.Router();

// Admin logic using central middleware

// GET all users (Admin only)
router.get('/users', protect, admin, async (req, res) => {
    try {
        const users = await User.find().select('-password').sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch users' });
    }
});

// DELETE a user (Admin only)
router.delete('/users/:id', protect, admin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });
        
        if (user.role === 'admin') {
            return res.status(400).json({ error: 'Cannot delete an admin user' });
        }

        await User.findByIdAndDelete(req.params.id);
        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete user' });
    }
});

// Update user password (Admin only)
router.put('/users/:id/password', protect, admin, async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found' });

        user.password = newPassword;
        await user.save();

        res.json({ message: 'Password updated successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update password' });
    }
});

// FULL PURGE: Delete all users (except admins), messages, and rooms
router.delete('/app/reset', protect, admin, async (req, res) => {
    try {
        // Delete all non-admin users
        const usersResult = await User.deleteMany({ role: { $ne: 'admin' } });
        
        // Delete all messages
        const msgsResult = await Message.deleteMany({});
        
        // Delete all rooms
        const roomsResult = await Room.deleteMany({});

        res.json({ 
            message: 'Application data purged successfully',
            stats: {
                usersDeleted: usersResult.deletedCount,
                messagesDeleted: msgsResult.deletedCount,
                roomsDeleted: roomsResult.deletedCount
            }
        });
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({ error: 'Failed to purge data' });
    }
});

export default router;
