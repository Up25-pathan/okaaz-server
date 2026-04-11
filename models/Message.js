import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    text: {
        type: String,
        default: '',
    },
    type: {
        type: String,
        enum: ['text', 'image', 'voice', 'video', 'document', 'system'],
        default: 'text',
    },
    channel: {
        type: String,
        default: 'general',
        index: true,
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        default: null,
    },
    isForwarded: {
        type: Boolean,
        default: false
    },
    reactions: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String }
    }],
    mediaUrl: {
        type: String,
        default: '',
    },
    fileName: {
        type: String,
        default: '',
    },
    fileSize: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ['sent', 'delivered', 'read'],
        default: 'sent'
    },
    deliveredTo: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        time: { type: Date, default: Date.now }
    }],
    readBy: [{
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        time: { type: Date, default: Date.now }
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export default mongoose.model('Message', messageSchema);
