import express from 'express';
import AppVersion from '../models/AppVersion.js';
import { protect, admin } from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/system/version - Get latest version info
router.get('/version', async (req, res) => {
    try {
        let version = await AppVersion.findOne().sort({ updatedAt: -1 });
        if (!version) {
            // Seed the first official update
            version = await AppVersion.create({
                latestVersion: '1.0.1',
                downloadUrl: 'https://github.com/Up25-pathan/okaaz-server/releases/download/v1.0.1/app-release.apk',
                isCritical: false
            });
        }
        res.json(version);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch version info' });
    }
});

// POST /api/system/version - Update latest version (Admin only)
router.post('/version', protect, admin, async (req, res) => {
    const { latestVersion, downloadUrl, isCritical } = req.body;
    try {
        const version = await AppVersion.create({
            latestVersion,
            downloadUrl,
            isCritical: isCritical || false
        });
        res.status(201).json(version);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update version info' });
    }
});

export default router;
