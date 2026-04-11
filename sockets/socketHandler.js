import Message from '../models/Message.js';
import User from '../models/User.js';
import Group from '../models/Group.js';
import { sendPushNotification, broadcastPushNotification } from '../utils/notificationService.js';

const onlineUsers = new Map(); // Socket.id -> { userId, username, lastSeen }
const userSockets = new Map(); // userId -> Set of socket.ids

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

                io.emit('presence_update', { userId: userId, status: 'online' });
                console.log(`User ${userData.username} is online`);
            }
        });

        socket.on('join_room', (roomId) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId}`);
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

                io.to(messageData.channel).emit('receive_message', newMessage);

                // ── Send Push Notifications ──
                if (messageData.channel.startsWith('dm_')) {
                    const participants = messageData.channel.replace('dm_', '').split('_');
                    const recipientId = participants.find(id => id !== messageData.sender.toString());
                    
                    if (recipientId) {
                        const recipient = await User.findById(recipientId).select('fcmToken');
                        if (recipient?.fcmToken) {
                            sendPushNotification(recipient.fcmToken, {
                                title: newMessage.sender.username,
                                body: newMessage.type === 'text' ? newMessage.text : 'Sent an attachment',
                                data: { channelId: messageData.channel, type: 'chat' }
                            });
                        }

                        // Check for socket delivery
                        if (userSockets.has(recipientId)) {
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
                    const group = await Group.findOne({ groupId: messageData.channel }).select('members');
                    if (group) {
                        const otherMembers = await User.find({ 
                            _id: { $in: group.members, $ne: messageData.sender } 
                        }).select('fcmToken');
                        
                        const tokens = otherMembers.map(m => m.fcmToken).filter(t => t);
                        if (tokens.length > 0) {
                            broadcastPushNotification(tokens, {
                                title: `Group: ${messageData.channel}`, // Placeholder, usually group name
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
