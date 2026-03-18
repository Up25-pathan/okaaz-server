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
        enum: ['text', 'image'],
        default: 'text',
    },
    channel: {
        type: String,
        enum: ['general', 'announcement'],
        default: 'general',
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Message',
        default: null,
    },
    reactions: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        emoji: { type: String }
    }],
    mediaUrl: {
        type: String,
        default: '',
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export default mongoose.model('Message', messageSchema);
