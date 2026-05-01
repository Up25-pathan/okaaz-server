import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import AppVersion from '../models/AppVersion.js';

const pushUpdate = async () => {
    await connectDB();
    
    const versionData = {
        latestVersion: '1.0.2',
        downloadUrl: 'https://github.com/Up25-pathan/okaaz-server/releases/download/v1.0.2/app-release.apk',
        isCritical: false
    };

    try {
        const update = await AppVersion.create(versionData);
        console.log('✅ Update pushed to database:', update);
    } catch (error) {
        console.error('❌ Failed to push update:', error);
    } finally {
        mongoose.disconnect();
    }
};

pushUpdate();
