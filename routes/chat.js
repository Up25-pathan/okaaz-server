import express from 'express';
import { protect } from './auth.js';
import Message from '../models/Message.js';
import Group from '../models/Group.js';
import mongoose from 'mongoose';

const router = express.Router();

// Create a new group
router.post('/groups', protect, async (req, res) => {
    try {
        const { name, description, members } = req.body;
        if (!name) return res.status(400).json({ error: 'Group name is required' });

        const groupId = `group_${Date.now()}`;
        const memberIds = [...new Set([...members, req.user._id.toString()])];

        const group = new Group({
            groupId,
            name,
            description,
            members: memberIds,
            admins: [req.user._id],
            createdBy: req.user._id
        });

        await group.save();
        res.status(201).json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create group' });
    }
});

// Update group (admins only)
router.put('/groups/:id', protect, async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id });
        if (!group) return res.status(404).json({ error: 'Group not found' });

        if (!group.admins.includes(req.user._id)) {
            return res.status(403).json({ error: 'Only admins can update group settings' });
        }

        const { name, description, members, admins } = req.body;
        if (name) group.name = name;
        if (description) group.description = description;
        if (members) group.members = members;
        if (admins) group.admins = admins;

        await group.save();
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update group' });
    }
});

// Mark message as read
router.post('/messages/:id/read', protect, async (req, res) => {
    try {
        const message = await Message.findById(req.params.id);
        if (!message) return res.status(404).json({ error: 'Message not found' });

        // Update status for DM
        if (message.channel.startsWith('dm_')) {
            message.status = 'read';
        }

        // Add to readBy if not already there
        const alreadyRead = message.readBy.some(r => r.user.toString() === req.user._id.toString());
        if (!alreadyRead) {
            message.readBy.push({ user: req.user._id, time: new Date() });
            await message.save();
            
            // Broadcast read event through global IO (passed from server.js if needed or using a singleton)
            if (req.app.get('io')) {
                req.app.get('io').to(message.channel).emit('message_read', {
                    messageId: message._id,
                    userId: req.user._id,
                    channel: message.channel
                });
            }
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark as read' });
    }
});

// Fetch active conversations (DMs and Groups)
router.get('/conversations', protect, async (req, res) => {
    try {
        const userIdStr = req.user._id.toString();
        
        // 1. Get DMs
        const dmRegex = new RegExp(`^dm_.*${userIdStr}.*`);
        const dms = await Message.aggregate([
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
                peerUser: { username: 1, avatarUrl: 1, email: 1, _id: 1, role: 1 },
                type: { $literal: 'dm' }
            }}
        ]);

        // 2. Get Groups the user is a member of
        const userGroups = await Group.find({ members: req.user._id });
        const groupConversations = await Promise.all(userGroups.map(async (g) => {
            const latestMessage = await Message.findOne({ channel: g.groupId }).sort({ createdAt: -1 }).populate('sender', 'username');
            return {
                channel: g.groupId,
                latestMessage: latestMessage || { text: 'No messages yet', createdAt: g.createdAt },
                groupInfo: g,
                type: 'group'
            };
        }));

        const all = [...dms, ...groupConversations].sort((a, b) => 
            new Date(b.latestMessage.createdAt) - new Date(a.latestMessage.createdAt)
        );

        res.json(all);
    } catch (error) {
        console.error('Conversations error:', error);
        res.status(500).json({ error: 'Failed to fetch conversations' });
    }
});

// Chat History
router.get('/history', protect, async (req, res) => {
    try {
        const { channel } = req.query;
        if (!channel) return res.status(400).json({ error: 'Channel is required' });

        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const messages = await Message.find({ channel })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .populate('sender', 'username email avatarUrl role')
            .populate({ path: 'replyTo', populate: { path: 'sender', select: 'username' } });
        
        res.json(messages.reverse());
    } catch (error) {
        res.status(500).json({ error: 'Failed' });
    }
});

export default router;
