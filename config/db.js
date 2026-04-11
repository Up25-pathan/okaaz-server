import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const connectDB = async () => {
    try {
        let mongodbUri = process.env.MONGODB_URI;
        if (!mongodbUri) {
            console.error('❌ MONGODB_URI not found in environment variables');
            return;
        }

        // Clean up URI if needed
        mongodbUri = mongodbUri.trim();
        if (mongodbUri.startsWith('const uri = ')) {
            mongodbUri = mongodbUri.replace('const uri = ', '').trim();
        }
        if ((mongodbUri.startsWith('"') && mongodbUri.endsWith('"')) || 
            (mongodbUri.startsWith("'") && mongodbUri.endsWith("'"))) {
            mongodbUri = mongodbUri.substring(1, mongodbUri.length - 1);
        }

        const conn = await mongoose.connect(mongodbUri);
        console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
        return conn;
    } catch (error) {
        console.error(`❌ MongoDB Connection Error: ${error.message}`);
        // Instead of exiting, we let the server run to handle health checks
        // process.exit(1); 
    }
};

export default connectDB;
