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

// Schedule a meeting
router.post('/schedule', protect, async (req, res) => {
    const { title, description, hostId, scheduledTime, region, regionSpecific, ladiesOnly } = req.body;
    try {
        const isLadiesOnly = ladiesOnly === true && req.user.gender === 'female';
        const generatedRoomId = await generateRoomId();
        const room = new Room({
            roomId: generatedRoomId,
            title: title || 'Meeting',
            description: description || '',
            hostId,
            hostName: req.user.username,
            scheduledTime: new Date(scheduledTime),
            region: isLadiesOnly ? '' : (region || ''),
            regionSpecific: isLadiesOnly ? false : (regionSpecific === true),
            ladiesOnly: isLadiesOnly,
            status: 'scheduled'
        });
        await room.save();

        const meetingData = {
            roomId: room.roomId, title: room.title, description: room.description,
            hostName: req.user.username, scheduledTime: room.scheduledTime,
            region: room.region, regionSpecific: room.regionSpecific, ladiesOnly: room.ladiesOnly,
        };

        // ── Socket.IO Notification ──
        if (ioInstance) {
            let targetUserIds;
            if (room.ladiesOnly) {
                const femaleUsers = await User.find({ gender: 'female' }).select('_id');
                targetUserIds = femaleUsers.map(u => u._id.toString());
            } else if (room.regionSpecific && room.region) {
                const regionUsers = await User.find({ region: room.region }).select('_id');
                targetUserIds = regionUsers.map(u => u._id.toString());
            }

            if (targetUserIds) {
                targetUserIds.forEach(uid => ioInstance.to(uid).emit('meeting_scheduled', meetingData));
            } else {
                ioInstance.emit('meeting_scheduled', meetingData);
            }
        }

        // ── FCM Broadcast ──
        let targetUsers;
        if (room.ladiesOnly) {
            targetUsers = await User.find({ gender: 'female' }).select('fcmToken');
        } else if (room.regionSpecific && room.region) {
            targetUsers = await User.find({ region: room.region }).select('fcmToken');
        } else {
            targetUsers = await User.find({}).select('fcmToken');
        }
        const tokens = targetUsers.map(u => u.fcmToken).filter(t => t);
        if (tokens.length > 0) {
            let bodyText;
            if (room.ladiesOnly) {
                bodyText = `👩 ${req.user.username} scheduled "${room.title}" (Ladies only)`;
            } else if (room.region) {
                bodyText = `${req.user.username} scheduled "${room.title}" in ${room.region}`;
            } else {
                bodyText = `${req.user.username} scheduled "${room.title}"`;
            }
            broadcastPushNotification(tokens, {
                title: '📅 New Meeting Scheduled',
                body: bodyText,
                data: { roomId: room.roomId, type: 'meeting' }
            });
        }

        res.json({ message: 'Meeting scheduled successfully', room });
    } catch (error) {
        console.error('Error scheduling meeting:', error);
        res.status(500).json({ error: 'Failed to schedule meeting' });
    }
});

// Get upcoming scheduled meetings (filtered by region & gender)
router.get('/scheduled', protect, async (req, res) => {
    try {
        const filterConditions = [
            {
                $or: [
                    { status: 'active' },
                    { scheduledTime: { $gt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
                ]
            },
            {
                $or: [
                    { regionSpecific: { $ne: true } },
                    { region: req.user.region || '' },
                    { hostId: req.user._id.toString() },
                ]
            },
        ];

        // Hide ladiesOnly meetings from non-female users (host always sees own)
        if (req.user.gender !== 'female') {
            filterConditions.push({
                $or: [
                    { ladiesOnly: { $ne: true } },
                    { hostId: req.user._id.toString() },
                ]
            });
        }

        const meetings = await Room.find({
            status: { $in: ['scheduled', 'active'] },
            scheduledTime: { $exists: true, $ne: null },
            $and: filterConditions,
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
                // Notify members the meeting started
                if (ioInstance) {
                    const startData = {
                        roomId: room.roomId,
                        title: room.title,
                        hostName: room.hostName,
                        ladiesOnly: room.ladiesOnly,
                    };
                    let targetIds;
                    if (room.ladiesOnly) {
                        const femaleUsers = await User.find({ gender: 'female' }).select('_id');
                        targetIds = femaleUsers.map(u => u._id.toString());
                    } else if (room.regionSpecific && room.region) {
                        const regionUsers = await User.find({ region: room.region }).select('_id');
                        targetIds = regionUsers.map(u => u._id.toString());
                    }
                    if (targetIds) {
                        targetIds.forEach(uid => ioInstance.to(uid).emit('meeting_started', startData));
                    } else {
                        ioInstance.emit('meeting_started', startData);
                    }
                }

                // ── FCM Broadcast ──
                let targetUsers;
                if (room.ladiesOnly) {
                    targetUsers = await User.find({ gender: 'female' }).select('fcmToken');
                } else if (room.regionSpecific && room.region) {
                    targetUsers = await User.find({ region: room.region }).select('fcmToken');
                } else {
                    targetUsers = await User.find({}).select('fcmToken');
                }
                const tokens = targetUsers.map(u => u.fcmToken).filter(t => t);
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

// Private 1:1 Call Token (WhatsApp Style)
router.post('/token/private', protect, async (req, res) => {
    const { callRoomId, participantName, avatarUrl } = req.body;
    if (!callRoomId) return res.status(400).json({ error: 'callRoomId is required' });

    try {
        const token = await createToken(callRoomId, participantName, avatarUrl || '');
        const livekitUrl = process.env.LIVEKIT_URL || 'ws://localhost:7880';
        res.json({ token, url: livekitUrl });
    } catch (error) {
        res.status(500).json({ error: 'Failed to generate call token' });
    }
});

// Respond to a private call (used for CallKit when socket might be disconnected)
router.post('/call-response', async (req, res) => {
    const { callerId, recipientId, response, callRoomId } = req.body;
    if (!ioInstance) return res.json({ success: false });

    const eventMap = {
        accepted: 'call:accepted',
        rejected: 'call:rejected',
        busy: 'call:busy',
    };
    const eventName = eventMap[response];
    if (eventName) {
        ioInstance.to(callerId).emit(eventName, { callRoomId, recipientId });
    }
    res.json({ success: true });
});

export default router;
