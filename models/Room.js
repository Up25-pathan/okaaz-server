import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
    roomId: {
        type: String,
        required: true,
        unique: true,
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
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

export default mongoose.model('Room', roomSchema);
