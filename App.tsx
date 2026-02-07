import React, { useState, useEffect, useRef } from 'react';
import { Template, DocumentFile, AnalysisResult } from './types';
import { generateTemplate, analyzeContract, draftEmail, suggestRevision, chatWithDoc } from './services/aiService';
import { parseFileContent } from './services/docService';
import { ResultsView } from './components/ResultsView';
import { CreateTemplateModal, MegaPromptModal, ModifyTemplateModal, RevisionModal, ConfirmationModal } from './components/Modals';
import { TemplateEditor } from './components/TemplateEditor';
import { TabularReview } from './components/TabularReview';
import { FileText, Plus, Upload, Play, Loader, LogOut, Layout, Layers, Users, Trash2, Check, AlertCircle, Table, Coins, Zap } from 'lucide-react';

// --- Simulated Backend (Mock) Implementation ---
// This replicates a database connection using LocalStorage so the app is fully functional without a server.

const initializeApp = (config: any) => ({});
const getAuth = (app: any) => ({});
const getFirestore = (app: any) => ({});

// Mock Auth
type User = { uid: string; email: string | null };
const mockUser: User = { uid: 'demo-user', email: 'demo@lexprompt.ai' };

const signInWithEmailAndPassword = async (auth: any, e: string, p: string) => {
    await new Promise(r => setTimeout(r, 500));
    sessionStorage.setItem('lexprompt_user', JSON.stringify(mockUser));
    window.dispatchEvent(new Event('auth-change'));
    return { user: mockUser };
};

const signOut = async (auth: any) => {
    sessionStorage.removeItem('lexprompt_user');
    window.dispatchEvent(new Event('auth-change'));
};

const onAuthStateChanged = (auth: any, cb: (user: User | null) => void) => {
    const check = () => {
        const u = sessionStorage.getItem('lexprompt_user');
        cb(u ? JSON.parse(u) : null);
    };
    window.addEventListener('auth-change', check);
    check();
    return () => window.removeEventListener('auth-change', check);
};

// Mock Firestore with LocalStorage Persistence
const collection = (db: any, path: string) => path;
const query = (ref: any, ...args: any[]) => ref;

const STORAGE_KEY = 'lexprompt_templates_v1';
const loadTemplates = (): Template[] => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) { console.error(e); }
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

let localTemplates: Template[] = loadTemplates();
let listeners: { query: string, cb: (snap: any) => void }[] = [];

const saveToStorage = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localTemplates));
};

const notifyListeners = () => {
    listeners.forEach(({ query, cb }) => {
        const isTeam = query.includes('public') || query.includes('team');
        const data = localTemplates.filter(t => isTeam ? t.scope === 'team' : t.scope === 'private');
        cb({ 
            docs: data.map(t => ({ 
                id: t.id, 
                data: () => t 
            })) 
        });
    });
};

const onSnapshot = (ref: any, cb: (snap: any) => void) => {
    const queryStr = String(ref);
    listeners.push({ query: queryStr, cb });
    // Initial call
    setTimeout(() => {
        const isTeam = queryStr.includes('public') || queryStr.includes('team');
        const data = localTemplates.filter(t => isTeam ? t.scope === 'team' : t.scope === 'private');
        cb({ 
            docs: data.map(t => ({ 
                id: t.id, 
                data: () => t 
            })) 
        });
    }, 50);
    return () => {
        listeners = listeners.filter(l => l.cb !== cb);
    };
};

const addDoc = async (ref: any, data: any) => {
    const newT = { ...data, id: Math.random().toString(36).substr(2, 9) };
    localTemplates = [...localTemplates, newT];
    saveToStorage();
    notifyListeners();
    return { id: newT.id };
};

const setDoc = async (ref: any, data: any) => {
    const id = ref.id;
    const exists = localTemplates.find(t => t.id === id);
    if (exists) {
        localTemplates = localTemplates.map(t => t.id === id ? { ...t, ...data } : t);
    } else {
        localTemplates = [...localTemplates, { ...data, id }];
    }
    saveToStorage();
    notifyListeners();
};

const deleteDoc = async (ref: any) => {
    const id = ref.id;
    // Filter out the deleted ID from the local array
    localTemplates = localTemplates.filter(t => t.id !== id);
    saveToStorage();
    notifyListeners();
};

const doc = (db: any, path: string, id?: string) => ({ path, id });
const serverTimestamp = () => new Date().toISOString();

// --- End Simulated Backend ---

const firebaseConfig = { apiKey: "PLACEHOLDER", authDomain: "lexprompt.firebaseapp.com", projectId: "lexprompt" };
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Token/Credit Costs
export const COSTS = {
    TEMPLATE_GEN: 25,
    ANALYSIS_PER_DOC: 15,
    CHAT: 1,
    REVISION: 5,
    EMAIL: 2,
    MODIFY_TEMPLATE: 10
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [credits, setCredits] = useState(150); // Initial free credits
  const [view, setView] = useState<'dashboard' | 'editor' | 'processor' | 'results' | 'tabular'>('dashboard');
  
  // Data State
  const [templates, setTemplates] = useState<Template[]>([]);
  const [teamTemplates, setTeamTemplates] = useState<Template[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // UI State
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notification, setNotification] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  
  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [modifyModalOpen, setModifyModalOpen] = useState(false);
  const [revisionData, setRevisionData] = useState<{title: string, original: string, revised: string} | null>(null);

  // Auth Listener
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => setUser(u));
  }, []);

  // Fetch Templates (Mocked: one query for private, one for team)
  useEffect(() => {
    if (!user) return;
    const qPrivate = query(collection(db, `users/${user.uid}/templates`));
    const unsub1 = onSnapshot(qPrivate, (snap) => {
      setTemplates(snap.docs.map((d: any) => ({ id: d.id, ...d.data(), scope: 'private' })));
    });

    const qTeam = query(collection(db, `public/data/templates`)); // Mock path
    const unsub2 = onSnapshot(qTeam, (snap) => {
      setTeamTemplates(snap.docs.map((d: any) => ({ id: d.id, ...d.data(), scope: 'team' })));
    });

    return () => { unsub1(); unsub2(); };
  }, [user]);

  const showNotify = (msg: string, type: 'success' | 'error' = 'success') => {
      setNotification({ msg, type });
      setTimeout(() => setNotification(null), 3000);
  };

  const checkCredits = (cost: number) => {
      if (credits < cost) {
          showNotify(`Insufficient credits. Need ${cost}, have ${credits}.`, 'error');
          return false;
      }
      return true;
  };

  const deductCredits = (cost: number) => {
      setCredits(prev => prev - cost);
  };

  // Actions
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try { await signInWithEmailAndPassword(auth, email, password); } 
    catch (err) { alert("Login failed."); }
    setLoading(false);
  };

  const handleCreateTemplate = async (params: any) => {
    if (params.type === 'ai' && !checkCredits(COSTS.TEMPLATE_GEN)) return;

    setLoading(true);
    try {
      let newT: Template;
      if (params.type === 'manual') {
          newT = {
             name: params.templateName,
             contractType: 'Custom',
             mode: 'extraction',
             systemPrompt: "You are an expert legal contract reviewer.",
             formatPrompt: "Extract the following clauses into a JSON format.",
             riskTolerance: "",
             clauses: [],
             scope: 'private',
             createdAt: serverTimestamp()
          };
      } else {
           // @ts-ignore
          const generated = await generateTemplate(params.contractType, params.templateDetail, params.outputDetail, params.context);
          deductCredits(COSTS.TEMPLATE_GEN);
          newT = {
            name: params.contractType,
            contractType: params.contractType,
            mode: 'extraction',
            systemPrompt: generated.systemPrompt!,
            formatPrompt: generated.formatPrompt!,
            riskTolerance: generated.riskTolerance,
            clauses: generated.clauses!,
            scope: 'private',
            createdAt: serverTimestamp()
          };
      }
      
      const ref = await addDoc(collection(db, `users/${user!.uid}/templates`), newT);
      setActiveTemplate({ ...newT, id: ref.id });
      setCreateModalOpen(false);
      setView('editor');
      showNotify("Template created successfully");
    } catch (e) { showNotify("Template creation failed", 'error'); }
    setLoading(false);
  };

  const handleSaveTemplate = async () => {
      if(!activeTemplate) return;
      await setDoc(doc(db, `users/${user!.uid}/templates`, activeTemplate.id!), activeTemplate);
      showNotify("Template saved successfully");
  };

  const handleDeleteClick = (id: string, e: React.MouseEvent) => {
      e.stopPropagation(); // Stop event from bubbling to the card click handler
      setDeleteId(id); // Open the custom confirmation modal
  };

  const confirmDelete = async () => {
      if(deleteId) {
          await deleteDoc(doc(db, '', deleteId)); 
          showNotify("Template deleted");
          setDeleteId(null);
      }
  };

  const handleImportClick = () => {
      fileInputRef.current?.click();
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if(!file) return;

      setLoading(true);
      const reader = new FileReader();
      reader.onload = async (event) => {
          try {
              const data = JSON.parse(event.target?.result as string);
              if(!data.clauses) throw new Error("Invalid format");
              const newT = { ...data, name: data.name + " (Import)", id: undefined, createdAt: serverTimestamp(), scope: 'private' };
              await addDoc(collection(db, `users/${user!.uid}/templates`), newT);
              showNotify("Imported successfully");
          } catch(e) { showNotify("Import failed", 'error'); }
          finally { setLoading(false); }
      };
      reader.readAsText(file);
      e.target.value = ''; // Reset so same file can be selected again
  };

  const handleModifyTemplate = async (instruction: string) => {
      if(!activeTemplate) return;
      if (!checkCredits(COSTS.MODIFY_TEMPLATE)) return;

      setLoading(true);
      setTimeout(() => {
          showNotify(`Template updated (Simulated). Cost: ${COSTS.MODIFY_TEMPLATE} credits.`);
          deductCredits(COSTS.MODIFY_TEMPLATE);
          setModifyModalOpen(false);
          setLoading(false);
      }, 1000);
  };

  const handleSuggestRevision = async (clause: string, original: string, issue: string) => {
      // Check handled in ResultsView, but double check here if needed
      setLoading(true);
      try {
          const revised = await suggestRevision(clause, original, issue);
          setRevisionData({ title: clause, original, revised });
      } catch (e) { showNotify("Failed to generate revision", 'error'); }
      setLoading(false);
  };

  const handleAnalysis = async (mode: 'batch' | 'collection') => {
    if (!activeTemplate || documents.length === 0) return;
    
    // Calculate cost
    const cost = documents.length * COSTS.ANALYSIS_PER_DOC;
    if (!checkCredits(cost)) return;

    setLoading(true);
    try {
      const newResults: AnalysisResult[] = [];
      if (mode === 'batch') {
        for (const [idx, doc] of documents.entries()) {
          const data = await analyzeContract(activeTemplate, [doc]);
          newResults.push({ id: Math.random().toString(), title: doc.name, data, docIndices: [idx], timestamp: new Date() });
        }
      } else {
        const data = await analyzeContract(activeTemplate, documents);
        newResults.push({ id: Math.random().toString(), title: "Collection Analysis", data, docIndices: documents.map((_, i) => i), timestamp: new Date() });
      }
      deductCredits(cost);
      setResults(newResults);
      setView('results');
    } catch (e) { showNotify("Analysis failed", 'error'); console.error(e); }
    setLoading(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setLoading(true);
      const files: DocumentFile[] = [];
      for (const file of Array.from(e.target.files)) {
        files.push(await parseFileContent(file));
      }
      setDocuments(files);
      setLoading(false);
      showNotify(`${files.length} document(s) uploaded`);
    }
  };

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-md p-8 bg-[#111] rounded-2xl border border-white/10">
        <h1 className="text-2xl font-bold text-white mb-6 flex items-center gap-2"><Layout className="text-violet-500"/> LexPrompt Ent.</h1>
        <form onSubmit={handleLogin} className="space-y-4">
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="Email (any)" className="w-full p-3 bg-black/50 border border-white/10 rounded text-white" />
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="Password (any)" className="w-full p-3 bg-black/50 border border-white/10 rounded text-white" />
          <button disabled={loading} className="w-full p-3 bg-violet-600 rounded text-white font-bold">{loading ? <Loader className="animate-spin mx-auto"/> : "Sign In"}</button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      {/* Toast Notification */}
      {notification && (
        <div className={`fixed bottom-8 right-8 px-6 py-3 rounded-lg shadow-2xl z-[100] flex items-center gap-3 border ${notification.type === 'error' ? 'bg-red-900/90 border-red-500 text-red-100' : 'bg-violet-900/90 border-violet-500 text-violet-100'} backdrop-blur-md transition-all animate-in fade-in slide-in-from-bottom-5`}>
            {notification.type === 'error' ? <AlertCircle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
            <span className="font-medium text-sm">{notification.msg}</span>
        </div>
      )}

      {/* Header */}
      <header className="h-16 border-b border-white/10 bg-[#111] flex items-center justify-between px-6 shrink-0">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('dashboard')}>
          <div className="w-8 h-8 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-lg flex items-center justify-center text-white"><FileText className="w-5 h-5" /></div>
          <span className="font-bold text-lg text-white">LexPrompt</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 bg-black/50 px-3 py-1.5 rounded-full border border-white/5" title="Available Credits">
             <Coins className="w-4 h-4 text-yellow-500" />
             <span className="text-sm font-bold text-white">{credits}</span>
             <button onClick={() => setCredits(c => c + 100)} className="ml-2 w-5 h-5 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center text-[10px] text-white" title="Simulate Top-Up">+</button>
          </div>
          <div className="h-4 w-px bg-white/10" />
          <button onClick={() => setView('dashboard')} className={`text-sm ${view === 'dashboard' ? 'text-white' : 'text-gray-400'}`}>Dashboard</button>
          <div className="h-4 w-px bg-white/10" />
          <button onClick={() => signOut(auth)} className="text-gray-400 hover:text-white"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden">
        
        {view === 'dashboard' && (
          <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto">
            <div className="flex justify-between items-end mb-8">
              <div>
                 <h2 className="text-3xl font-bold text-white mb-2">Library</h2>
                 <p className="text-gray-400">Manage your contract review templates.</p>
              </div>
              <div className="flex gap-4">
                 <input 
                    type="file" 
                    accept=".json" 
                    ref={fileInputRef}
                    onChange={handleImport} 
                    className="hidden" 
                 />
                 <button 
                    onClick={handleImportClick} 
                    disabled={loading}
                    className="px-4 py-2 bg-white/5 border border-white/10 text-white rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-white/10 active:bg-white/20 active:scale-95 transition-all"
                 >
                    {loading ? <Loader className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    Import
                 </button>
                 <button onClick={() => setCreateModalOpen(true)} className="px-4 py-2 bg-violet-600 text-white rounded-lg flex items-center gap-2 text-sm font-medium hover:bg-violet-500 active:scale-95 transition-all shadow-lg shadow-violet-900/20"><Plus className="w-4 h-4" /> Create Template</button>
              </div>
            </div>

            <div className="space-y-10">
                <section>
                    <h3 className="text-gray-500 text-xs font-bold uppercase tracking-wider mb-4">My Templates</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {templates.map(t => (
                        <div key={t.id} className="group relative bg-[#1a1a1a] border border-white/10 rounded-xl hover:border-violet-500/50 transition-colors shadow-lg flex flex-col">
                            {/* Main Content Area - Clickable */}
                            <div 
                                className="p-5 flex-1 flex flex-col cursor-pointer"
                                onClick={() => { setActiveTemplate(t); setView('editor'); }}
                            >
                                <div className="flex justify-between items-start mb-2">
                                    <h3 className="font-bold text-white text-lg truncate pr-8">{t.name}</h3>
                                </div>
                                <p className="text-xs text-gray-500 mb-4 line-clamp-2 min-h-[32px]">{t.systemPrompt}</p>
                                
                                <div className="mt-auto flex gap-2">
                                    <button className="flex-1 py-2 bg-white/5 rounded text-xs text-gray-300 hover:bg-white/10 font-medium">Edit</button>
                                    <button 
                                        onClick={(e) => { e.stopPropagation(); setActiveTemplate(t); setView('processor'); }} 
                                        className="flex-1 py-2 bg-violet-600/20 text-violet-300 rounded text-xs hover:bg-violet-600/30 font-bold flex items-center justify-center gap-2 z-10"
                                    >
                                        <Play className="w-3 h-3"/> Run
                                    </button>
                                </div>
                            </div>

                            {/* Delete Button - Positioned absolutely but outside the main click flow logic */}
                            <button
                                onClick={(e) => handleDeleteClick(t.id!, e)} 
                                className="absolute top-3 right-3 p-2 bg-[#222] border border-white/10 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/50 rounded-lg transition-all shadow-md z-30"
                                title="Delete Template"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    ))}
                    {templates.length === 0 && <div className="col-span-3 text-gray-500 border border-dashed border-white/10 p-8 rounded-xl text-center">You haven't created any templates yet.</div>}
                    </div>
                </section>

                <section>
                    <h3 className="text-violet-400 text-xs font-bold uppercase tracking-wider mb-4 flex items-center gap-2"><Users className="w-4 h-4" /> Team Shared</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {teamTemplates.map(t => (
                        <div key={t.id} className="bg-[#1a1a1a] border border-violet-500/20 p-5 rounded-xl hover:border-violet-500 transition-colors relative shadow-lg">
                            <h3 className="font-bold text-white mb-2 text-lg truncate">{t.name}</h3>
                            <p className="text-xs text-gray-500 mb-4 line-clamp-2 min-h-[32px]">{t.systemPrompt}</p>
                            <div className="flex gap-2">
                                <button onClick={() => { setActiveTemplate(t); setView('editor'); }} className="flex-1 py-2 bg-white/5 rounded text-xs text-gray-300 hover:bg-white/10 font-medium">View</button>
                                <button onClick={() => { setActiveTemplate(t); setView('processor'); }} className="flex-1 py-2 bg-violet-600 rounded text-white hover:bg-violet-500 font-bold flex items-center justify-center gap-2"><Play className="w-3 h-3"/> Run</button>
                            </div>
                        </div>
                    ))}
                    </div>
                </section>
            </div>
          </div>
        )}

        {view === 'editor' && activeTemplate && (
            <TemplateEditor 
                template={activeTemplate} 
                setTemplate={setActiveTemplate}
                onSave={handleSaveTemplate}
                onExport={() => {
                    const blob = new Blob([JSON.stringify(activeTemplate, null, 2)], {type: "application/json"});
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = `${activeTemplate.name}.json`; a.click();
                }}
                onShowMegaPrompt={() => setMegaPromptOpen(true)}
                onModifyWithAI={() => setModifyModalOpen(true)}
                onClose={() => setView('dashboard')}
            />
        )}

        {view === 'processor' && activeTemplate && (
            <div className="p-8 max-w-3xl mx-auto h-full flex flex-col justify-center items-center">
                <div className="w-full bg-[#1a1a1a] border border-white/10 rounded-2xl p-8 shadow-2xl">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-xl font-bold text-white">Run Analysis: {activeTemplate.name}</h2>
                        <button onClick={() => setView('dashboard')} className="text-xs text-gray-500 hover:text-white">Cancel</button>
                    </div>
                    
                    <div className="border-2 border-dashed border-white/10 rounded-xl p-10 text-center mb-6 hover:bg-white/5 transition-colors relative bg-[#111]">
                        <input type="file" multiple onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                        <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
                        <p className="text-sm text-gray-400">Drag files here or click to upload</p>
                        <p className="text-xs text-gray-600 mt-2">Supports PDF, DOCX, TXT</p>
                    </div>

                    {documents.length > 0 && (
                        <div className="mb-6 space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                            {documents.map((d, i) => (
                                <div key={i} className="flex items-center justify-between text-xs text-gray-300 bg-white/5 p-2 rounded border border-white/5">
                                    <span>{d.name}</span>
                                    <span className="opacity-50">Ready</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex gap-4">
                        <button onClick={() => handleAnalysis('batch')} disabled={loading || !documents.length} className="flex-1 py-3 bg-blue-600/20 text-blue-300 border border-blue-600/30 rounded-lg font-medium hover:bg-blue-600/30 flex items-center justify-center gap-2 transition-colors disabled:opacity-50">
                            <Layers className="w-4 h-4" /> Batch Run
                            {documents.length > 0 && <span className="text-[10px] bg-blue-900/50 px-1.5 py-0.5 rounded text-blue-200 ml-1">{documents.length * COSTS.ANALYSIS_PER_DOC}c</span>}
                        </button>
                        <button onClick={() => handleAnalysis('collection')} disabled={loading || !documents.length} className="flex-1 py-3 bg-violet-600 text-white rounded-lg font-bold hover:bg-violet-500 flex items-center justify-center gap-2 transition-colors disabled:opacity-50 shadow-lg">
                            <Play className="w-4 h-4" /> Analyze Collection
                            {documents.length > 0 && <span className="text-[10px] bg-violet-800 px-1.5 py-0.5 rounded text-violet-200 ml-1">{documents.length * COSTS.ANALYSIS_PER_DOC}c</span>}
                        </button>
                        {/* NEW: Tabular Review Trigger */}
                         <button onClick={() => setView('tabular')} disabled={loading || !documents.length} className="flex-1 py-3 bg-emerald-600/20 text-emerald-300 border border-emerald-600/30 rounded-lg font-medium hover:bg-emerald-600/30 flex items-center justify-center gap-2 transition-colors disabled:opacity-50"><Table className="w-4 h-4" /> Tabular Review</button>
                    </div>
                    
                    {loading && <div className="mt-4 text-center text-xs text-gray-400 flex items-center justify-center gap-2"><Loader className="animate-spin w-4 h-4" /> Processing with Gemini...</div>}
                </div>
            </div>
        )}

        {view === 'results' && (
            <ResultsView 
                results={results} 
                documents={documents} 
                loadingAi={loading}
                userCredits={credits}
                onConsumeCredits={(cost) => {
                    if (checkCredits(cost)) {
                        deductCredits(cost);
                        return true;
                    }
                    return false;
                }}
                onDraftEmail={async (data) => {
                     const emailBody = await draftEmail(data);
                     alert(emailBody);
                }}
                onSuggestRevision={handleSuggestRevision}
                onChat={(q) => chatWithDoc("", q, documents.map(d => d.content).join("\n"))}
            />
        )}

        {view === 'tabular' && (
             <TabularReview 
                documents={documents} 
                initialTemplate={activeTemplate}
                onClose={() => setView('dashboard')}
            />
        )}

      </main>

      {/* Global Modals */}
      <CreateTemplateModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} onCreate={handleCreateTemplate} loading={loading} />
      <MegaPromptModal isOpen={megaPromptOpen} onClose={() => setMegaPromptOpen(false)} template={activeTemplate || undefined} />
      <ModifyTemplateModal isOpen={modifyModalOpen} onClose={() => setModifyModalOpen(false)} onModify={handleModifyTemplate} loading={loading} />
      <RevisionModal isOpen={!!revisionData} onClose={() => setRevisionData(null)} data={revisionData} />
      
      {/* Confirmation Modal */}
      <ConfirmationModal 
          isOpen={!!deleteId}
          title="Delete Template"
          message="Are you sure you want to permanently delete this template? This action cannot be undone."
          onClose={() => setDeleteId(null)}
          onConfirm={confirmDelete}
      />
    </div>
  );
}