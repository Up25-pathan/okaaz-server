import express from 'express';
import { protect } from '../utils/authMiddleware.js';
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

// Get group details
router.get('/groups/:id', protect, async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id })
            .populate('members', 'username avatarUrl email bio')
            .populate('admins', 'username avatarUrl')
            .populate('createdBy', 'username');
        
        if (!group) return res.status(404).json({ error: 'Group not found' });
        if (!group.members.some(m => m._id.toString() === req.user._id.toString())) {
            return res.status(403).json({ error: 'Access denied' });
        }
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch group details' });
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

        const { name, description, profileUrl, admins, members } = req.body;
        if (name) group.name = name;
        if (description) group.description = description;
        if (profileUrl !== undefined) group.profileUrl = profileUrl;
        if (admins) group.admins = admins;
        if (members) group.members = members;

        await group.save();
        res.json(group);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update group' });
    }
});

// Leave or Remove member
router.delete('/groups/:id/members/:userId', protect, async (req, res) => {
    try {
        const group = await Group.findOne({ groupId: req.params.id });
        if (!group) return res.status(404).json({ error: 'Group not found' });

        const targetUserId = req.params.userId;
        const isSelf = targetUserId === req.user._id.toString();
        const isAdmin = group.admins.includes(req.user._id);

        if (!isSelf && !isAdmin) {
            return res.status(403).json({ error: 'Unauthorized' });
        }

        group.members = group.members.filter(m => m.toString() !== targetUserId);
        group.admins = group.admins.filter(a => a.toString() !== targetUserId);

        if (group.members.length === 0) {
            await Group.findOneAndDelete({ groupId: req.params.id });
            return res.json({ message: 'Group deleted as it has no members' });
        }

        // If the only admin leaves, appoint a new one
        if (group.admins.length === 0 && group.members.length > 0) {
            group.admins.push(group.members[0]);
        }

        await group.save();
        res.json({ message: 'Member removed', group });
    } catch (error) {
        res.status(500).json({ error: 'Failed' });
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

// Mark all messages as read in a channel (Bulk)
router.post('/messages/read-all', protect, async (req, res) => {
    try {
        const { channel } = req.body;
        if (!channel) return res.status(400).json({ error: 'Channel is required' });

        const userId = req.user._id;

        if (channel.startsWith('dm_')) {
            // DMs: Update where sender is NOT the current user and status is NOT read
            await Message.updateMany(
                { channel, sender: { $ne: userId }, status: { $ne: 'read' } },
                { $set: { status: 'read' } }
            );
        } else {
            // Groups: push the user to readBy array for messages they haven't read
            await Message.updateMany(
                { channel, 'readBy.user': { $ne: userId } },
                { $push: { readBy: { user: userId, time: new Date() } } }
            );
        }

        // Broadcast to notify peer
        if (req.app.get('io')) {
            req.app.get('io').to(channel).emit('channel_messages_read', {
                userId: userId,
                channel: channel
            });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to mark all as read' });
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

        const dmsWithUnread = await Promise.all(dms.map(async (dm) => {
            const unreadCount = await Message.countDocuments({
                channel: dm.channel,
                sender: { $ne: req.user._id },
                status: { $ne: 'read' }
            });
            return { ...dm, unreadCount };
        }));

        const userGroups = await Group.find({ members: req.user._id });
        const groupConversations = await Promise.all(userGroups.map(async (g) => {
            const latestMessage = await Message.findOne({ channel: g.groupId }).sort({ createdAt: -1 }).populate('sender', 'username');
            const unreadCount = await Message.countDocuments({
                channel: g.groupId,
                'readBy.user': { $ne: req.user._id },
                sender: { $ne: req.user._id } // user's own messages shouldn't be counted as unread mathematically (though handled by frontend often)
            });
            return {
                channel: g.groupId,
                latestMessage: latestMessage || { text: 'No messages yet', createdAt: g.createdAt },
                groupInfo: g,
                type: 'group',
                unreadCount
            };
        }));

        const all = [...dmsWithUnread, ...groupConversations].sort((a, b) => 
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
