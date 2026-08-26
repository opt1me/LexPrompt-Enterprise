import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getAnalytics } from "firebase/analytics";

const firebaseConfig = {
    apiKey: "AIzaSyCuIgKsf7oLJXLzO8ZWsGbWGD_kO8aEkDc",
    authDomain: "lexprompt-976ad.firebaseapp.com",
    projectId: "lexprompt-976ad",
    storageBucket: "lexprompt-976ad.firebasestorage.app",
    messagingSenderId: "814174908048",
    appId: "1:814174908048:web:910349c4370d6a13a13215",
    measurementId: "G-JY25H23EN4"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);
export const analytics = typeof window !== 'undefined' ? getAnalytics(app) : null;
