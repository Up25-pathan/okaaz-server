import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true,
    },
    title: {
        type: String,
        default: 'Meeting',
    },
    hostId: {
        type: String,
        required: true,
    },
    scheduledTime: {
        type: Date,
    },
    status: {
        type: String,
        enum: ['scheduled', 'active', 'ended'],
        default: 'active',
    },
    participants: [{
        type: String,
    }],
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export default mongoose.model('Room', roomSchema);
