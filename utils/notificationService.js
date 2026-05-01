import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serviceAccountPath = path.join(__dirname, '../firebase-service-account.json');
let messaging = null;

// Tries to initialize Firebase from Environment Variable (for Render/Production)
// or from a local file (for local development)
const initializeFirebase = () => {
    try {
        let serviceAccount = null;

        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            // Load from Environment Variable
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            console.log('✓ Firebase initialized from Environment Variable');
        } else if (fs.existsSync(serviceAccountPath)) {
            // Fallback to local file
            serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath));
            console.log('✓ Firebase initialized from local JSON file');
        }

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
            });
            messaging = admin.messaging();
        } else {
            console.warn('⚠ WARNING: No Firebase credentials found. Push notifications disabled.');
        }
    } catch (e) {
        console.error('✘ Failed to initialize Firebase Admin:', e.message);
    }
};

initializeFirebase();

/**
 * Send a push notification to a specific user
 * @param {string} token - FCM Device Token
 * @param {object} payload - Notification data { title, body, data }
 */
export const sendPushNotification = async (token, { title, body, data = {} }) => {
    if (!messaging) {
        console.warn('✘ FCM: Cannot send notification - Firebase Admin not initialized.');
        return;
    }
    if (!token) {
        console.warn('✘ FCM: Cannot send notification - No recipient token provided.');
        return;
    }

    const message = {
        data: data,
        token: token,
    };

    if (title || body) {
        message.notification = { title, body };
    }


    try {
        const response = await messaging.send(message);
        console.log(`✓ FCM Success: Sent to ${token.substring(0, 10)}... (Response: ${response})`);
    } catch (error) {
        console.error('✘ FCM Error:', error.message);
    }
};

/**
 * Broadcast notification to all users (for meetings)
 * @param {string[]} tokens - Array of FCM Device Tokens
 * @param {object} payload - Notification data
 */
export const broadcastPushNotification = async (tokens, { title, body, data = {} }) => {
    if (!messaging || !tokens || tokens.length === 0) return;

    // Filter out empty tokens
    const validTokens = tokens.filter(t => t && t.length > 0);
    if (validTokens.length === 0) return;

    const message = {
        notification: { title, body },
        data: data,
        tokens: validTokens,
    };

    try {
        const response = await messaging.sendEachForMulticast(message);
        console.log(`FCM Broadcast: ${response.successCount} sent, ${response.failureCount} failed`);
    } catch (error) {
        console.error('FCM Broadcast Error:', error.message);
    }
};
