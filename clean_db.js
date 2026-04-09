import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '.env') });

const messageSchema = new mongoose.Schema({
    channel: String,
});
const Message = mongoose.model('Message', messageSchema);

async function clean() {
    let mongodbUri = process.env.MONGODB_URI;
    if (mongodbUri) {
        mongodbUri = mongodbUri.trim();
        if (mongodbUri.startsWith('const uri = ')) {
            mongodbUri = mongodbUri.replace('const uri = ', '').trim();
        }
        if ((mongodbUri.startsWith('"') && mongodbUri.endsWith('"')) || 
            (mongodbUri.startsWith("'") && mongodbUri.endsWith("'"))) {
            mongodbUri = mongodbUri.substring(1, mongodbUri.length - 1);
        }
    } else {
        console.log("No DB URI");
        process.exit(1);
    }

    await mongoose.connect(mongodbUri);
    console.log("Connected. Cleaning up old DMs...");
    const res = await Message.deleteMany({ channel: { $nin: ['general', 'announcement'] } });
    console.log(`Deleted ${res.deletedCount} corrupted DM messages.`);
    process.exit(0);
}
clean();
