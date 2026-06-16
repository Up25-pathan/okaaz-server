import express from 'express';
import { protect } from '../utils/authMiddleware.js';
import BlockedUser from '../models/BlockedUser.js';
import User from '../models/User.js';

const router = express.Router();

// Block a user
router.post('/block', protect, async (req, res) => {
  try {
    const { blockedUserId } = req.body;
    if (!blockedUserId) return res.status(400).json({ error: 'blockedUserId is required' });
    if (blockedUserId === req.user._id.toString()) return res.status(400).json({ error: 'Cannot block yourself' });

    const existing = await BlockedUser.findOne({ blocker: req.user._id, blocked: blockedUserId });
    if (existing) return res.json({ message: 'Already blocked' });

    await BlockedUser.create({ blocker: req.user._id, blocked: blockedUserId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to block user' });
  }
});

// Unblock a user
router.post('/unblock', protect, async (req, res) => {
  try {
    const { blockedUserId } = req.body;
    await BlockedUser.findOneAndDelete({ blocker: req.user._id, blocked: blockedUserId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to unblock user' });
  }
});

// Get blocked users list
router.get('/blocked', protect, async (req, res) => {
  try {
    const blocks = await BlockedUser.find({ blocker: req.user._id })
      .populate('blocked', 'username avatarUrl email bio');
    res.json(blocks.map(b => b.blocked));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch blocked users' });
  }
});

// Check if a user is blocked (by either side)
router.get('/status/:userId', protect, async (req, res) => {
  try {
    const targetId = req.params.userId;
    const [iBlockThem, theyBlockMe] = await Promise.all([
      BlockedUser.findOne({ blocker: req.user._id, blocked: targetId }),
      BlockedUser.findOne({ blocker: targetId, blocked: req.user._id }),
    ]);
    res.json({
      iBlockThem: !!iBlockThem,
      theyBlockMe: !!theyBlockMe,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check block status' });
  }
});

export default router;
