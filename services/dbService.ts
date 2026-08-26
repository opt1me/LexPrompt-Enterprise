import { Template } from '../types';
import { auth, db } from '../firebase';
import {
    onAuthStateChanged as firebaseOnAuthStateChanged,
    signOut as firebaseSignOut,
    User as FirebaseUser
} from 'firebase/auth';
import {
    collection,
    doc,
    setDoc,
    deleteDoc,
    query,
    where,
    onSnapshot,
    orderBy,
    serverTimestamp as firestoreTimestamp
} from 'firebase/firestore';

export type User = FirebaseUser;

// --- Auth Service ---

export const signOut = () => firebaseSignOut(auth);

export const onAuthStateChanged = (cb: (user: User | null) => void) => {
    return firebaseOnAuthStateChanged(auth, cb);
};

// --- Firestore Service ---

export const subscribeToTemplates = (cb: (templates: Template[]) => void) => {
    // Fetch all templates for the unified library
    const q = query(collection(db, 'templates'));

    return onSnapshot(q, (snapshot) => {
        const templates = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Template));

        // Sort in-memory to handle legacy documents and pending writes
        const sorted = templates.sort((a, b) => {
            const getTime = (t: any) => {
                if (!t) return Date.now() + 60000; // Future timestamp for pending writes
                if (typeof t.toMillis === 'function') return t.toMillis();
                if (t instanceof Date) return t.getTime();
                if (typeof t === 'number') return t;
                return 0;
            };
            return getTime(b.updatedAt) - getTime(a.updatedAt);
        });

        cb(sorted);
    });
};

export const serverTimestamp = firestoreTimestamp;

export const addTemplate = async (userId: string, userEmail: string, template: Template): Promise<{ id: string }> => {
    const docRef = doc(collection(db, 'templates'));
    const newTemplate = {
        ...template,
        id: docRef.id,
        createdById: userId,
        createdByEmail: userEmail,
        createdAt: firestoreTimestamp(),
        updatedAt: firestoreTimestamp()
    };
    await setDoc(docRef, newTemplate);
    return { id: docRef.id };
};

export const updateTemplate = async (userId: string, template: Template): Promise<void> => {
    if (!template.id) return;
    const docRef = doc(db, 'templates', template.id);
    await setDoc(docRef, { ...template, updatedAt: firestoreTimestamp() }, { merge: true });
};

export const deleteTemplate = async (userId: string, templateId: string): Promise<void> => {
    const docRef = doc(db, 'templates', templateId);
    await deleteDoc(docRef);
};
