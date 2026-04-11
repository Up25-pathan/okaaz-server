import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import Room from '../models/Room.js';
import { protect } from './auth.js';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

const createToken = async (roomName, participantName, metadata = '') => {
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: participantName,
        metadata: metadata,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
    return await at.toJwt();
};

// Schedule a meeting
router.post('/schedule', protect, async (req, res) => {
    const { roomId, title, hostId, scheduledTime } = req.body;

    if (!roomId || !hostId || !scheduledTime) {
        return res.status(400).json({ error: 'roomId, hostId, and scheduledTime are required' });
    }

    try {
        const room = new Room({
            roomId,
            title: title || 'Meeting',
            hostId,
            scheduledTime: new Date(scheduledTime),
            status: 'scheduled'
        });
        await room.save();
        res.json({ message: 'Meeting scheduled successfully', room });
    } catch (error) {
        console.error('Error scheduling meeting:', error);
        res.status(500).json({ error: 'Failed to schedule meeting' });
    }
});

// Get scheduled/upcoming meetings for the user
router.get('/scheduled', protect, async (req, res) => {
    try {
        const userId = req.user._id.toString();
        const meetings = await Room.find({
            status: { $in: ['scheduled', 'active'] },
            $or: [
                { hostId: userId },
                { participants: userId }
            ]
        }).sort({ scheduledTime: 1 });

        // Also find meetings where anyone can join (public)
        const publicMeetings = await Room.find({
            status: { $in: ['scheduled', 'active'] },
        }).sort({ scheduledTime: 1 });

        // Merge and de-duplicate
        const allMeetings = [...meetings];
        for (const pm of publicMeetings) {
            if (!allMeetings.find(m => m.roomId === pm.roomId)) {
                allMeetings.push(pm);
            }
        }

        res.json(allMeetings);
    } catch (error) {
        console.error('Error fetching scheduled meetings:', error);
        res.status(500).json({ error: 'Failed to fetch scheduled meetings' });
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
            room = new Room({ 
                roomId,
                title: roomId,
                hostId: userId || userName,
                status: 'active' 
            });
            await room.save();
        }

        // Logic for scheduled meetings
        if (room.status === 'scheduled') {
            if (userId === room.hostId || userName === room.hostId) {
                room.status = 'active';
                await room.save();
            } else {
                return res.status(403).json({ 
                    error: 'Meeting has not started yet. Please wait for the host to join.' 
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
        res.json({ token, url: livekitUrl });
    } catch (error) {
        console.error('Error joining room:', error);
        res.status(500).json({ error: 'Failed to join room' });
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
