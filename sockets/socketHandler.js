import Message from '../models/Message.js';

const onlineUsers = new Map();

export const setupSocket = (io) => {
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id);

        socket.on('join_channel', (channel) => {
            socket.join(channel);
            console.log(`Socket ${socket.id} joined channel: ${channel}`);
        });

        // Track user presence
        socket.on('user_connected', (userData) => {
            if (userData && userData._id) {
                onlineUsers.set(socket.id, {
                    userId: userData._id,
                    username: userData.username,
                    lastSeen: new Date()
                });
                // Broadcast to everyone that this user is online
                io.emit('presence_update', { userId: userData._id, status: 'online' });
                console.log(`User ${userData.username} is online`);
            }
        });

        // Join a specific chat room (Hub Group or DM)
        socket.on('join_room', (roomId) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId}`);
        });

        socket.on('leave_room', (roomId) => {
            socket.leave(roomId);
            console.log(`User ${socket.id} left room: ${roomId}`);
        });

        // Typing Indicators
        socket.on('typing', (data) => {
            socket.to(data.roomId).emit('user_typing', {
                userId: data.userId,
                username: data.username,
                roomId: data.roomId
            });
        });

        socket.on('stop_typing', (data) => {
            socket.to(data.roomId).emit('user_stopped_typing', {
                userId: data.userId,
                roomId: data.roomId
            });
        });

        // Reply and Reaction Handling
        socket.on('add_reaction', async (data) => {
            try {
                const message = await Message.findById(data.messageId);
                if (message) {
                    const existing = message.reactions.find(r => r.userId.toString() === data.userId && r.emoji === data.emoji);
                    if (existing) {
                        message.reactions = message.reactions.filter(r => r._id !== existing._id);
                    } else {
                        message.reactions.push({ userId: data.userId, emoji: data.emoji });
                    }
                    await message.save();
                    io.to(data.roomId).emit('message_reaction_updated', {
                        messageId: message._id,
                        reactions: message.reactions
                    });
                }
            } catch (e) {
                console.error('Error adding reaction:', e);
            }
        });

        socket.on('send_message', async (messageData) => {
            try {
                const newMessage = new Message(messageData);
                await newMessage.save();

                await newMessage.populate([
                    { path: 'sender', select: 'username email avatarUrl' },
                    { path: 'replyTo', populate: { path: 'sender', select: 'username' } }
                ]);

                const room = messageData.channel;
                io.to(room).emit('receive_message', newMessage);
            } catch (error) {
                console.error('Error saving message:', error);
            }
        });

        // Hand Raise Event
        socket.on('hand_raise', (data) => {
            // data: { roomId, userId, username, active: true/false }
            io.to(data.roomId).emit('user_hand_raised', data);
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.id}`);
            const user = onlineUsers.get(socket.id);
            if (user) {
                io.emit('presence_update', { 
                    userId: user.userId, 
                    status: 'offline',
                    lastSeen: new Date()
                });
                onlineUsers.delete(socket.id);
            }
        });
    });
};

export const getOnlineUsers = () => onlineUsers;
