import { Template } from '../types';

// Mock Auth types
export type User = { uid: string; email: string | null };

const STORAGE_KEY = 'lexprompt_templates_v1';

// Initial Mock User
export const mockUser: User = { uid: 'demo-user', email: 'demo@lexprompt.ai' };

// --- Auth Service ---

export const signInWithEmailAndPassword = async (email: string, password: string): Promise<{ user: User }> => {
    await new Promise(r => setTimeout(r, 500));
    sessionStorage.setItem('lexprompt_user', JSON.stringify(mockUser));
    window.dispatchEvent(new Event('auth-change'));
    return { user: mockUser };
};

export const signOut = async () => {
    sessionStorage.removeItem('lexprompt_user');
    window.dispatchEvent(new Event('auth-change'));
};

export const onAuthStateChanged = (cb: (user: User | null) => void) => {
    const check = () => {
        const u = sessionStorage.getItem('lexprompt_user');
        cb(u ? JSON.parse(u) : null);
    };
    window.addEventListener('auth-change', check);
    check();
    return () => window.removeEventListener('auth-change', check);
};

// --- Firestore Service (Mocked) ---

let localTemplates: Template[] = [];

const loadTemplatesFromStorage = (): Template[] => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) {
        console.error('Error loading templates from storage:', e);
    }
    return [
        {
            id: 'demo-1',
            name: 'SaaS Agreement',
            contractType: 'SaaS',
            mode: 'risk',
            systemPrompt: 'You are a senior legal counsel reviewing a SaaS agreement.',
            formatPrompt: 'Extract key risks.',
            riskTolerance: 'Low',
            clauses: [
                { id: '1', title: 'Indemnity', prompt: 'Summarize indemnification obligations.' },
                { id: '2', title: 'Liability Cap', prompt: 'What is the liability cap?' }
            ],
            createdAt: new Date().toISOString(),
            scope: 'private'
        },
        {
            id: 'team-1',
            name: 'Standard NDA',
            contractType: 'NDA',
            mode: 'extraction',
            systemPrompt: 'You are an NDA specialist.',
            formatPrompt: 'Extract key terms.',
            clauses: [
                { id: '1', title: 'Confidentiality Period', prompt: 'How long does confidentiality last?' }
            ],
            createdAt: new Date().toISOString(),
            scope: 'team'
        }
    ];
};

localTemplates = loadTemplatesFromStorage();

let listeners: { scope: 'private' | 'team', cb: (templates: Template[]) => void }[] = [];

const saveToStorage = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localTemplates));
};

const notifyListeners = () => {
    listeners.forEach(({ scope, cb }) => {
        const data = localTemplates.filter(t => t.scope === scope);
        cb(data);
    });
};

export const subscribeToTemplates = (userId: string, scope: 'private' | 'team', cb: (templates: Template[]) => void) => {
    const listener = { scope, cb };
    listeners.push(listener);

    // Initial data
    setTimeout(() => {
        cb(localTemplates.filter(t => t.scope === scope));
    }, 50);

    return () => {
        listeners = listeners.filter(l => l !== listener);
    };
};

export const addTemplate = async (userId: string, template: Template): Promise<{ id: string }> => {
    const id = Math.random().toString(36).substr(2, 9);
    const newTemplate = { ...template, id };
    localTemplates = [...localTemplates, newTemplate];
    saveToStorage();
    notifyListeners();
    return { id };
};

export const updateTemplate = async (userId: string, template: Template): Promise<void> => {
    const id = template.id;
    localTemplates = localTemplates.map(t => t.id === id ? { ...t, ...template } : t);
    saveToStorage();
    notifyListeners();
};

export const deleteTemplate = async (userId: string, templateId: string): Promise<void> => {
    localTemplates = localTemplates.filter(t => t.id !== templateId);
    saveToStorage();
    notifyListeners();
};

export const serverTimestamp = () => new Date().toISOString();
