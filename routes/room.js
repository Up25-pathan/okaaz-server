import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import Room from '../models/Room.js';
import dotenv from 'dotenv';
dotenv.config();

const router = express.Router();

const createToken = async (roomName, participantName) => {
    // If this room doesn't exist, it will be automatically created when the first
    // client joins.
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
        identity: participantName,
    });

    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });

    return await at.toJwt();
};

router.post('/schedule', async (req, res) => {
    const { roomId, hostId, scheduledTime } = req.body;

    if (!roomId || !hostId || !scheduledTime) {
        return res.status(400).json({ error: 'roomId, hostId, and scheduledTime are required' });
    }

    try {
        const room = new Room({
            roomId,
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

router.post('/join', async (req, res) => {
    const { roomId, userName, userId } = req.body;

    if (!roomId || !userName) {
        return res.status(400).json({ error: 'roomId and userName are required' });
    }

    try {
        let room = await Room.findOne({ roomId });

        if (!room) {
            // If room doesn't exist, create it as active (legacy/quick start)
            room = new Room({ 
                roomId, 
                hostId: userId || userName, // Fallback if userId not provided
                status: 'active' 
            });
            await room.save();
        }

        // Logic for scheduled meetings
        if (room.status === 'scheduled') {
            if (userId === room.hostId || userName === room.hostId) {
                // Host is joining, start the meeting
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

        const token = await createToken(roomId, userName);
        const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';
        console.log(`Generated token for ${userName} in room ${roomId}`);
        res.json({ token, url: livekitUrl });
    } catch (error) {
        console.error('Error joining room:', error);
        res.status(500).json({ error: 'Failed to join room' });
    }
});

export default router;
