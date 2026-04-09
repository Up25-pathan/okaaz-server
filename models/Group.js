import mongoose from 'mongoose';

const GroupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true }, // e.g., 'general', 'announcement'
  name: { type: String, required: true },
  description: { type: String, default: 'Welcome to the OKAAZ group!' },
  profileUrl: { type: String, default: '' },
  isAnnouncementOnly: { type: Boolean, default: false },
  members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  admins: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  createdAt: { type: Date, default: Date.now },
});

const Group = mongoose.model('Group', GroupSchema);
export default Group;
