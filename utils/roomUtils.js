import Room from '../models/Room.js';

/**
 * Generates a unique meeting ID in the format okaaz-xxxxxx
 * where xxxxxx is a 6-digit number.
 */
export const generateRoomId = async () => {
    let roomId = '';
    let isUnique = false;

    while (!isUnique) {
        // Generate a random 6-digit number
        const digits = Math.floor(100000 + Math.random() * 900000).toString();
        roomId = `okaaz-${digits}`;

        // Verify uniqueness in DB
        const existing = await Room.findOne({ roomId });
        if (!existing) {
            isUnique = true;
        }
    }

    return roomId;
};
