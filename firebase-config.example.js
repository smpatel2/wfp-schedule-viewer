/**
 * Firebase configuration template.
 *
 * To set up:
 * 1. Create a Firebase project at https://console.firebase.google.com
 * 2. Enable Firestore Database (start in test mode, then apply firestore.rules)
 * 3. Register a Web App in Project Settings
 * 4. Copy your config values below
 * 5. Rename this file to firebase-config.js
 */
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.firebasestorage.app",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

export default firebaseConfig;
