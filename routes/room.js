import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import Room from '../models/Room.js';
import { protect } from '../utils/authMiddleware.js';
import dotenv from 'dotenv';
import User from '../models/User.js';
import { broadcastPushNotification } from '../utils/notificationService.js';
import { generateRoomId } from '../utils/roomUtils.js';
dotenv.config();

const router = express.Router();

// Store io reference - will be set from server.js
let ioInstance = null;
export const setIO = (io) => { ioInstance = io; };

const createToken = async (roomName, participantName, metadata = '') => {
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: participantName,
        metadata: metadata,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return await at.toJwt();
};

// Schedule a meeting (visible to ALL OKAAZ members)
router.post('/schedule', protect, async (req, res) => {
    const { title, description, hostId, scheduledTime } = req.body;
    try {
        const generatedRoomId = await generateRoomId();
        const room = new Room({
            roomId: generatedRoomId,
            title: title || 'Meeting',
            description: description || '',
            hostId,
            hostName: req.user.username,
            scheduledTime: new Date(scheduledTime),
            status: 'scheduled'
        });
        await room.save();

        // Broadcast notification to ALL connected members via Socket.IO
        if (ioInstance) {
            ioInstance.emit('meeting_scheduled', {
                roomId: room.roomId, title: room.title, description: room.description,
                hostName: req.user.username, scheduledTime: room.scheduledTime,
            });
        }

        // ── FCM Broadcast ──
        const allUsers = await User.find({}).select('fcmToken');
        const tokens = allUsers.map(u => u.fcmToken).filter(t => t);
        if (tokens.length > 0) {
            broadcastPushNotification(tokens, {
                title: '📅 New Meeting Scheduled',
                body: `${req.user.username} scheduled "${room.title}"`,
                data: { roomId: room.roomId, type: 'meeting' }
            });
        }

        res.json({ message: 'Meeting scheduled successfully', room });
    } catch (error) {
        console.error('Error scheduling meeting:', error);
        res.status(500).json({ error: 'Failed to schedule meeting' });
    }
});

// Get ALL upcoming scheduled meetings (visible to every OKAAZ member)
router.get('/scheduled', protect, async (req, res) => {
    try {
        const meetings = await Room.find({
            status: { $in: ['scheduled', 'active'] },
            scheduledTime: { $exists: true, $ne: null },
            $or: [
                { status: 'active' },
                { scheduledTime: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
            ]
        }).sort({ scheduledTime: 1 });

        res.json(meetings);
    } catch (error) {
        console.error('Error fetching scheduled meetings:', error);
        res.status(500).json({ error: 'Failed to fetch scheduled meetings' });
    }
});

// Purge old/dummy data — one-time cleanup endpoint
router.delete('/cleanup', protect, async (req, res) => {
    try {
        // Delete all rooms that are:
        // 1. status 'active' but have no scheduledTime (instant meetings that are stale)
        // 2. status 'ended'
        const result = await Room.deleteMany({
            $or: [
                { status: 'ended' },
                { status: 'active', scheduledTime: { $exists: false } },
                { status: 'active', scheduledTime: null },
            ]
        });
        res.json({ message: `Cleaned up ${result.deletedCount} stale rooms.` });
    } catch (error) {
        res.status(500).json({ error: 'Cleanup failed' });
    }
});

// Join a meeting room (generate LiveKit token)
router.post('/join', async (req, res) => {
    const { roomId, userName, userId } = req.body;

    if (!roomId || !userName) {
        return res.status(400).json({ error: 'roomId and userName are required' });
    }

    try {
        let room = await Room.findOne({ roomId });

        if (!room) {
            return res.status(404).json({ error: 'Meeting room not found or not registered.' });
        }

        // Logic for scheduled meetings
        if (room.status === 'scheduled') {
            if (userId === room.hostId || userName === room.hostId) {
                room.status = 'active';
                await room.save();
                // Notify everyone the meeting started
                if (ioInstance) {
                    ioInstance.emit('meeting_started', {
                        roomId: room.roomId,
                        title: room.title,
                        hostName: room.hostName,
                    });
                }

                // ── FCM Broadcast ──
                const allUsers = await User.find({}).select('fcmToken');
                const tokens = allUsers.map(u => u.fcmToken).filter(t => t);
                if (tokens.length > 0) {
                    broadcastPushNotification(tokens, {
                        title: '🟢 Meeting Started',
                        body: `${room.hostName} started "${room.title}" — Join now!`,
                    });
                }
            } else {
                return res.status(403).json({ 
                    error: 'LOBBY_WAITING',
                    message: 'Meeting has not started yet. Please wait for the host to join.' 
                });
            }
        }

        if (room.status === 'ended') {
            return res.status(400).json({ error: 'This meeting has already ended.' });
        }

        // Track participant
        if (userId && !room.participants.includes(userId)) {
            room.participants.push(userId);
            await room.save();
        }

        const { avatarUrl } = req.body;
        const token = await createToken(roomId, userName, avatarUrl || '');
        const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';
        console.log(`Generated token for ${userName} in room ${roomId}`);
        res.json({ token, url: livekitUrl, hostName: room.hostName });
    } catch (error) {
        console.error('Error joining room:', error);
        res.status(500).json({ error: 'Failed to join room' });
    }
});

// Create an instant meeting record
router.post('/instant', protect, async (req, res) => {
    const { title } = req.body;
    try {
        const generatedRoomId = await generateRoomId();
        const room = new Room({
            roomId: generatedRoomId,
            title: title || 'Instant Meeting',
            hostId: req.user._id.toString(),
            hostName: req.user.username,
            status: 'active'
        });
        await room.save();
        res.json(room);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create instant meeting' });
    }
});

// End a meeting
router.post('/end', protect, async (req, res) => {
    const { roomId } = req.body;
    try {
        const room = await Room.findOneAndUpdate(
            { roomId },
            { status: 'ended' },
            { returnDocument: 'after' }
        );
        if (!room) return res.status(404).json({ error: 'Room not found' });
        res.json({ message: 'Meeting ended', room });
    } catch (error) {
        res.status(500).json({ error: 'Failed to end meeting' });
    }
});

export default router;
