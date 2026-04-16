import Message from '../models/Message.js';
import User from '../models/User.js';
import Group from '../models/Group.js';
import Room from '../models/Room.js';
import { sendPushNotification, broadcastPushNotification } from '../utils/notificationService.js';

const onlineUsers = new Map(); // Socket.id -> { userId, username, lastSeen }
const userSockets = new Map(); // userId -> Set of socket.ids
const meetingTimeouts = new Map(); // roomId -> Timeout object
const activeMeetingParticipants = new Map(); // roomId -> Set of userIds

export const setupSocket = (io) => {
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id);

        socket.on('user_connected', (userData) => {
            if (userData && userData._id) {
                const userId = userData._id.toString();
                onlineUsers.set(socket.id, {
                    userId: userId,
                    username: userData.username,
                    lastSeen: new Date()
                });

                if (!userSockets.has(userId)) {
                    userSockets.set(userId, new Set());
                }
                userSockets.get(userId).add(socket.id);
                
                // Join their own private room for direct signaling (notifications/calls)
                socket.join(userId);

                io.emit('presence_update', { userId: userId, status: 'online' });
                console.log(`User ${userData.username} is online`);
            }
        });

        socket.on('join_room', (roomId) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId}`);
        });

        socket.on('join_call_room', async ({ roomId, userId }) => {
            socket.join(roomId);
            if (!activeMeetingParticipants.has(roomId)) {
                activeMeetingParticipants.set(roomId, new Set());
            }
            activeMeetingParticipants.get(roomId).add(userId);

            // If host reconnects, cancel the termination timer
            const room = await Room.findOne({ roomId });
            if (room && room.hostId === userId) {
                if (meetingTimeouts.has(roomId)) {
                    console.log(`Host reconnected to ${roomId}. Cancelling timeout.`);
                    clearTimeout(meetingTimeouts.get(roomId));
                    meetingTimeouts.delete(roomId);
                }
            }
        });

        socket.on('leave_call_room', async ({ roomId, userId }) => {
            socket.leave(roomId);
            if (activeMeetingParticipants.has(roomId)) {
                activeMeetingParticipants.get(roomId).delete(userId);
            }

            // If host leaves, start 3-minute grace period
            const room = await Room.findOne({ roomId });
            if (room && room.hostId === userId && room.status !== 'ended') {
                console.log(`Host ${userId} left room ${roomId}. Starting 3min grace period.`);
                const timeout = setTimeout(async () => {
                    room.status = 'ended';
                    await room.save();
                    io.to(roomId).emit('meeting_ended', { reason: 'Host has left the meeting.' });
                    meetingTimeouts.delete(roomId);
                    console.log(`Meeting ${roomId} ended due to host host absence.`);
                }, 3 * 60 * 1000); // 3 minutes
                meetingTimeouts.set(roomId, timeout);
            }
        });

        socket.on('leave_room', (roomId) => {
            socket.leave(roomId);
            console.log(`User ${socket.id} left room: ${roomId}`);
        });

        socket.on('typing', (data) => {
            socket.to(data.roomId).emit('user_typing', data);
        });

        socket.on('stop_typing', (data) => {
            socket.to(data.roomId).emit('user_stopped_typing', data);
        });

        socket.on('send_message', async (messageData) => {
            try {
                const newMessage = new Message({
                    ...messageData,
                    status: 'sent'
                });
                await newMessage.save();

                await newMessage.populate([
                    { path: 'sender', select: 'username email avatarUrl role' },
                    { path: 'replyTo', populate: { path: 'sender', select: 'username' } }
                ]);

                const msgObj = newMessage.toObject();
                // Ensure front-end parses _id to id if expected, or rely on normal logic.
                if (messageData.clientId) {
                    msgObj.clientId = messageData.clientId;
                }
                io.to(messageData.channel).emit('receive_message', msgObj);

                // ── Send Push Notifications ──
                if (messageData.channel.startsWith('dm_')) {
                    const participants = messageData.channel.replace('dm_', '').split('_');
                    const recipientId = participants.find(id => id !== messageData.sender.toString());
                    
                    if (recipientId) {
                        const recipient = await User.findById(recipientId).select('fcmToken');
                        const isOnline = userSockets.has(recipientId);

                        if (recipient?.fcmToken && !isOnline) {
                            sendPushNotification(recipient.fcmToken, {
                                title: newMessage.sender.username,
                                body: newMessage.type === 'text' ? newMessage.text : 'Sent an attachment',
                                data: { channelId: messageData.channel, type: 'chat' }
                            });
                        }

                        // Check for socket delivery
                        if (isOnline) {
                            newMessage.status = 'delivered';
                            newMessage.deliveredTo.push({ user: recipientId, time: new Date() });
                            await newMessage.save();
                            
                            io.to(messageData.channel).emit('message_status_update', {
                                messageId: newMessage._id, status: 'delivered', channel: messageData.channel
                            });
                        }
                    }
                } else {
                    // Group Chat Push
                    const group = await Group.findOne({ groupId: messageData.channel }).select('members name');
                    if (group) {
                        const otherMembers = await User.find({ 
                            _id: { $in: group.members, $ne: messageData.sender } 
                        }).select('fcmToken');
                        
                        // Filter out empty tokens and tokens of users who are currently online
                        const tokens = otherMembers
                            .filter(m => !userSockets.has(m._id.toString()) && m.fcmToken)
                            .map(m => m.fcmToken);

                        if (tokens.length > 0) {
                            broadcastPushNotification(tokens, {
                                title: group.name,
                                body: `${newMessage.sender.username}: ${newMessage.type === 'text' ? newMessage.text : 'Attachment'}`,
                                data: { channelId: messageData.channel, type: 'group' }
                            });
                        }
                    }
                }
            } catch (error) {
                console.error('Error sending message:', error);
            }
        });

        socket.on('add_reaction', async (data) => {
            try {
                const message = await Message.findById(data.messageId);
                if (message) {
                    const userIdStr = data.userId.toString();
                    const existingIndex = message.reactions.findIndex(r => r.userId.toString() === userIdStr && r.emoji === data.emoji);
                    
                    if (existingIndex > -1) {
                        message.reactions.splice(existingIndex, 1);
                    } else {
                        message.reactions.push({ userId: data.userId, emoji: data.emoji });
                    }
                    
                    await message.save();
                    io.to(data.channel).emit('message_reaction_updated', {
                        messageId: message._id,
                        reactions: message.reactions,
                        channel: data.channel
                    });
                }
            } catch (e) {
                console.error('Reaction error:', e);
            }
        });

        socket.on('delete_message', async (data) => {
            try {
                const message = await Message.findById(data.messageId);
                if (message && message.sender.toString() === data.userId) {
                    await Message.findByIdAndDelete(data.messageId);
                    io.to(data.channel).emit('message_deleted', {
                        messageId: data.messageId,
                        channel: data.channel
                    });
                }
            } catch (e) {
                console.error('Delete error:', e);
            }
        });

        // ── Private Call Signaling ──

        socket.on('private_call_invite', async (data) => {
            const { callerId, callerName, recipientId, type } = data; // type: 'audio' or 'video'
            console.log(`Call invite from ${callerName} (${callerId}) to ${recipientId}`);

            const recipientSockets = userSockets.get(recipientId);
            const isOnline = recipientSockets && recipientSockets.size > 0;

            // Generate a unique room ID for the private call if not provided
            const callRoomId = data.callRoomId || `call_${Date.now()}_${callerId}_${recipientId}`;

            if (isOnline) {
                // Send immediate socket signal if recipient is online
                io.to(recipientId).emit('incoming_call', {
                    callerId,
                    callerName,
                    callRoomId,
                    type,
                    callerAvatar: data.callerAvatar
                });
            }

            // ALWAYS send FCM for 1:1 calls to ensure background wake-up (VoIP style)
            const recipient = await User.findById(recipientId).select('fcmToken');
            if (recipient?.fcmToken) {
                // Note: For VoIP, data-only messages are better as they allow the app to 
                // decide how to show the notification (CallKit)
                sendPushNotification(recipient.fcmToken, {
                    title: 'Incoming Call',
                    body: `${callerName} is calling you...`,
                    data: {
                        type: 'voip_call',
                        callerId,
                        callerName,
                        callRoomId,
                        callType: type,
                        callerAvatar: data.callerAvatar || ''
                    }
                });
            }
        });

        socket.on('private_call_response', (data) => {
            const { callerId, recipientId, response, callRoomId } = data; // response: 'accepted', 'rejected', 'busy'
            console.log(`Call response from ${recipientId} to ${callerId}: ${response}`);
            
            // Forward the response to the caller
            io.to(callerId).emit('call_response_received', {
                recipientId,
                response,
                callRoomId
            });
        });

        socket.on('private_call_terminate', (data) => {
            const { otherPartyId, callRoomId } = data;
            console.log(`Call terminated in room ${callRoomId}`);
            io.to(otherPartyId).emit('call_terminated', { callRoomId });
        });

        socket.on('hand_raise', (data) => {
            io.to(data.roomId).emit('user_hand_raised', data);
        });

        socket.on('disconnect', () => {
            const user = onlineUsers.get(socket.id);
            if (user) {
                const userId = user.userId;
                const sockets = userSockets.get(userId);
                if (sockets) {
                    sockets.delete(socket.id);
                    if (sockets.size === 0) {
                        userSockets.delete(userId);
                        io.emit('presence_update', { 
                            userId: userId, 
                            status: 'offline',
                            lastSeen: new Date()
                        });
                    }
                }
                onlineUsers.delete(socket.id);
            }
        });
    });
};

export const getOnlineUsers = () => onlineUsers;
