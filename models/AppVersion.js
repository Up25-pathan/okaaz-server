import mongoose from 'mongoose';

const appVersionSchema = new mongoose.Schema({
    latestVersion: {
        type: String,
        required: true,
        default: '1.0.0'
    },
    downloadUrl: {
        type: String,
        required: true,
        default: ''
    },
    isCritical: {
        type: Boolean,
        default: false
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

export default mongoose.model('AppVersion', appVersionSchema);
