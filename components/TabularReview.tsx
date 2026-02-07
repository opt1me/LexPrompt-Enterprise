import React, { useState, useEffect, useRef } from 'react';
import { DocumentFile, TabularColumn, TabularData, TabularCell, Template } from '../types';
import { extractTabularData, analyzeTable } from '../services/aiService';
import { PDFViewer } from './PDFViewer';
import { AutoResizeTextarea } from './AutoResizeTextarea';
import { Plus, Table, FileText, Download, X, MessageSquare, Loader, CheckCircle2, AlertCircle, Maximize2, Minimize2, Edit3, Eye, AlignLeft, Bot, Type, Zap, ShieldAlert, MousePointerClick } from 'lucide-react';

interface TabularReviewProps {
    documents: DocumentFile[];
    initialTemplate?: Template | null;
    onClose: () => void;
}

export const TabularReview: React.FC<TabularReviewProps> = ({ documents, initialTemplate, onClose }) => {
    const [columns, setColumns] = useState<TabularColumn[]>([]);
    const [data, setData] = useState<TabularData>({});
    const [selectedCell, setSelectedCell] = useState<{ docId: string; colId: string } | null>(null);
    const [showChat, setShowChat] = useState(false);
    const [chatInput, setChatInput] = useState("");
    const [chatHistory, setChatHistory] = useState<{ role: string, content: string }[]>([]);
    const [isChatLoading, setIsChatLoading] = useState(false);
    const [isWrapText, setIsWrapText] = useState(false);
    const [isProcessing, setIsProcessing] = useState(false);
    const stopSignal = useRef(false);

    // UI State for "Add Column"
    const [newColTitle, setNewColTitle] = useState("");
    const [newColQuery, setNewColQuery] = useState("");
    const [isAddingCol, setIsAddingCol] = useState(false);

    // Initial Load
    useEffect(() => {
        if (initialTemplate && columns.length === 0) {
            const newCols = initialTemplate.clauses.map(c => ({
                id: c.id || Math.random().toString(),
                title: c.title,
                query: c.prompt,
                riskCriteria: c.riskCriteria
            }));
            setColumns(newCols);
            // Trigger batch processing for these columns
            processQueue(newCols);
        }
    }, [initialTemplate]);

    const processQueue = async (colsToProcess: TabularColumn[]) => {
        setIsProcessing(true);
        stopSignal.current = false;

        // Initialize cells as loading
        const nextData = { ...data };
        documents.forEach(doc => {
            if (!nextData[doc.id]) nextData[doc.id] = {};
            colsToProcess.forEach(col => {
                if (!nextData[doc.id][col.id] || nextData[doc.id][col.id].status === 'error') {
                    nextData[doc.id][col.id] = { value: "", citations: [], confidence: "Low", status: "loading" };
                }
            });
        });
        setData(nextData);

        // Process sequentially
        // Process documents sequentially, but columns in parallel
        for (const doc of documents) {
            if (stopSignal.current) break;

            const pendingCols = colsToProcess.filter(col => data[doc.id]?.[col.id]?.status !== 'done');

            await Promise.all(pendingCols.map(async (col) => {
                if (stopSignal.current) return;

                try {
                    const result = await extractTabularData(doc.content, col.query, col.riskCriteria);
                    setData(prev => ({
                        ...prev,
                        [doc.id]: {
                            ...prev[doc.id],
                            [col.id]: { ...result, status: 'done', isEdited: false }
                        }
                    }));
                } catch (e) {
                    setData(prev => ({
                        ...prev,
                        [doc.id]: {
                            ...prev[doc.id],
                            [col.id]: { value: "Error", citations: [], confidence: "Low", status: "error" }
                        }
                    }));
                }
            }));
        }
        setIsProcessing(false);
    };

    const handleStop = () => {
        stopSignal.current = true;
        setIsProcessing(false);
    };

    const handleRetryCell = async (docId: string, colId: string) => {
        const col = columns.find(c => c.id === colId);
        const doc = documents.find(d => d.id === docId);
        if (!col || !doc) return;

        setData(prev => ({
            ...prev,
            [docId]: {
                ...prev[docId],
                [colId]: { ...prev[docId][colId], status: 'loading' }
            }
        }));

        try {
            const result = await extractTabularData(doc.content, col.query);
            setData(prev => ({
                ...prev,
                [docId]: {
                    ...prev[docId],
                    [colId]: { ...result, status: 'done', isEdited: false }
                }
            }));
        } catch (e) {
            setData(prev => ({
                ...prev,
                [docId]: {
                    ...prev[docId],
                    [colId]: { value: "Error", citations: [], confidence: "Low", status: "error" }
                }
            }));
        }
    };

    const handleAddColumn = () => {
        if (!newColTitle || !newColQuery) return;
        const newCol: TabularColumn = {
            id: Math.random().toString(36).substr(2, 9),
            title: newColTitle,
            query: newColQuery
        };
        setColumns(prev => [...prev, newCol]);
        setNewColTitle("");
        setNewColQuery("");
        setIsAddingCol(false);
        processQueue([newCol]);
    };

    const handleCellUpdate = (val: string) => {
        if (!selectedCell) return;
        setData(prev => ({
            ...prev,
            [selectedCell.docId]: {
                ...prev[selectedCell.docId],
                [selectedCell.colId]: { ...prev[selectedCell.docId][selectedCell.colId], value: val, isEdited: true }
            }
        }));
    };

    const handleChat = async () => {
        if (!chatInput.trim()) return;
        setChatHistory(prev => [...prev, { role: 'user', content: chatInput }]);
        const q = chatInput;
        setChatInput("");
        setIsChatLoading(true);
        try {
            const resp = await analyzeTable(data, columns, q);
            setChatHistory(prev => [...prev, { role: 'assistant', content: resp }]);
        } catch (e) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: "Error analyzing table." }]);
        }
        setIsChatLoading(false);
    };

    const handleExport = () => {
        let csv = "Document," + columns.map(c => c.title).join(",") + "\n";
        documents.forEach(doc => {
            const row = [doc.name];
            columns.forEach(col => {
                const cell = data[doc.id]?.[col.id];
                row.push(`"${(cell?.value || "").replace(/"/g, '""')}"`);
            });
            csv += row.join(",") + "\n";
        });
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = "tabular_review.csv"; a.click();
    };

    const activeDoc = selectedCell ? documents.find(d => d.id === selectedCell.docId) : null;
    const activeCellData = selectedCell ? data[selectedCell.docId]?.[selectedCell.colId] : null;

    return (
        <div className="flex flex-col h-[calc(100vh-64px)] bg-[#09090b] text-gray-200 font-sans">
            {/* Toolbar */}
            <div className="h-14 border-b border-white/10 flex items-center justify-between px-6 bg-[#111] shrink-0">
                <div className="flex items-center gap-4">
                    <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="w-5 h-5" /></button>
                    <h2 className="font-bold text-white flex items-center gap-2"><Table className="w-5 h-5 text-emerald-500" /> Tabular Review</h2>
                    <span className="text-xs text-gray-500 bg-white/5 px-2 py-1 rounded border border-white/5">{documents.length} Docs</span>
                </div>
                <div className="flex items-center gap-3">
                    <button onClick={() => setIsWrapText(!isWrapText)} className={`px-3 py-2 text-xs font-medium rounded transition-colors flex items-center gap-2 border ${isWrapText ? 'bg-emerald-600/20 text-emerald-300 border-emerald-600/50' : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'}`}>
                        <AlignLeft className="w-4 h-4" /> Wrap
                    </button>
                    <button onClick={() => setShowChat(!showChat)} className={`px-3 py-2 text-xs font-medium rounded transition-colors flex items-center gap-2 border ${showChat ? 'bg-violet-600/20 text-violet-300 border-violet-600/50' : 'bg-white/5 text-gray-300 border-white/10 hover:bg-white/10'}`}>
                        <MessageSquare className="w-4 h-4" /> Chat
                    </button>
                    <button onClick={handleExport} className="px-3 py-2 text-xs font-medium rounded bg-white/5 hover:bg-white/10 text-gray-300 transition-colors flex items-center gap-2 border border-white/10"><Download className="w-4 h-4" /> Export</button>
                    {isProcessing ? (
                        <button onClick={handleStop} className="px-3 py-2 text-xs font-bold rounded bg-red-600/20 hover:bg-red-600/30 text-red-400 transition-colors flex items-center gap-2 border border-red-500/30"><X className="w-4 h-4" /> Stop</button>
                    ) : (
                        <button onClick={() => setIsAddingCol(true)} className="px-3 py-2 text-xs font-bold rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors flex items-center gap-2 border border-blue-400/50 shadow-lg shadow-blue-900/20"><Plus className="w-4 h-4" /> Add Column</button>
                    )}
                </div>
            </div>

            {/* Progress Bar */}
            {isProcessing && (
                <div className="h-1 bg-[#1a1a1a] w-full overflow-hidden">
                    <div className="h-full bg-blue-500 animate-pulse transition-all duration-500" style={{
                        width: `${(Object.values(data).flatMap(d => Object.values(d)).filter(c => c.status === 'done').length / (documents.length * columns.length || 1)) * 100}%`
                    }} />
                </div>
            )}

            <div className="flex-1 flex overflow-hidden relative">
                {/* Main Grid */}
                <div className={`flex-1 overflow-auto bg-[#09090b] relative transition-all duration-300 ${selectedCell ? 'w-[55%]' : 'w-full'}`}>
                    <table className="w-full border-collapse">
                        <thead className="bg-[#1a1a1a] sticky top-0 z-10 shadow-lg">
                            <tr>
                                <th className="text-left p-4 border-b border-r border-white/10 text-[11px] uppercase tracking-wider font-bold text-gray-500 w-64 sticky left-0 bg-[#1a1a1a] z-20 shadow-[1px_0_0_0_rgba(255,255,255,0.1)]">Document</th>
                                {columns.map(col => (
                                    <th key={col.id} className="text-left p-4 border-b border-r border-white/10 text-[11px] uppercase tracking-wider font-bold text-gray-400 min-w-[250px] group cursor-default">
                                        <div className="flex items-center gap-2">
                                            <Type className="w-3 h-3 text-gray-600" />
                                            <span className="group-hover:text-white transition-colors">{col.title}</span>
                                        </div>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {documents.map(doc => (
                                <tr key={doc.id} className="group hover:bg-[#111] transition-colors">
                                    <td className="p-3 border-b border-r border-white/10 text-xs font-medium text-white sticky left-0 bg-[#09090b] group-hover:bg-[#111] truncate max-w-[200px] shadow-[1px_0_0_0_rgba(255,255,255,0.1)]" title={doc.name}>
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded bg-white/5 flex items-center justify-center text-gray-400 border border-white/5 shrink-0"><FileText className="w-4 h-4" /></div>
                                            <span className="truncate">{doc.name}</span>
                                        </div>
                                    </td>
                                    {columns.map(col => {
                                        const cell = data[doc.id]?.[col.id];
                                        const isSelected = selectedCell?.docId === doc.id && selectedCell?.colId === col.id;
                                        return (
                                            <td
                                                key={col.id}
                                                onClick={() => setSelectedCell({ docId: doc.id, colId: col.id })}
                                                className={`p-3 border-b border-r border-white/10 text-xs cursor-pointer transition-colors relative ${isSelected ? 'bg-blue-500/10 shadow-[inset_0_0_0_2px_rgba(59,130,246,0.5)]' : ''}`}
                                            >
                                                {!cell || cell.status === 'loading' ? (
                                                    <div className="flex items-center gap-2 text-gray-500"><Loader className="w-3 h-3 animate-spin" /></div>
                                                ) : cell.status === 'error' ? (
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-red-400 bg-red-900/20 px-2 py-1 rounded">Error</span>
                                                        <button
                                                            onClick={(e) => { e.stopPropagation(); handleRetryCell(doc.id, col.id); }}
                                                            className="p-1 hover:bg-white/10 rounded text-gray-400 hover:text-white"
                                                            title="Retry"
                                                        >
                                                            <Zap className="w-3 h-3" />
                                                        </button>
                                                    </div>
                                                ) : (
                                                    <div className="flex items-start justify-between gap-2">
                                                        <div className={`${isWrapText ? 'whitespace-normal' : 'truncate'} ${cell.isEdited ? 'text-blue-300' : 'text-gray-300'} max-h-32 overflow-hidden`}>
                                                            {cell.value || <span className="text-gray-600 italic">Empty</span>}
                                                        </div>
                                                        {cell.confidence === 'Low' && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 shrink-0 mt-1" title="Low Confidence" />}
                                                    </div>
                                                )}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    {documents.length === 0 && <div className="p-10 text-center text-gray-500">No documents loaded. Go back to upload files.</div>}
                    {columns.length === 0 && documents.length > 0 && <div className="p-10 text-center text-gray-500">No columns defined. Click "Add Column" to start extraction.</div>}
                </div>

                {/* Analyst Review Panel (Responsive Slide-in) */}
                {selectedCell && activeDoc && activeCellData && (
                    <div className="w-[45%] border-l border-white/10 flex flex-col bg-[#0e0e0e] shadow-2xl z-20 absolute right-0 top-0 bottom-0 animate-in slide-in-from-right duration-300 h-full">
                        {/* Panel Header */}
                        <div className="h-14 border-b border-white/10 flex items-center justify-between px-6 bg-[#161616] shrink-0">
                            <div className="flex items-center gap-2 overflow-hidden">
                                <div className="bg-blue-600/20 p-1.5 rounded text-blue-400"><FileText className="w-4 h-4" /></div>
                                <div className="flex flex-col overflow-hidden">
                                    <span className="text-[10px] text-blue-400 font-bold uppercase tracking-wider">Analyst Review</span>
                                    <span className="text-xs font-bold text-gray-200 truncate" title={activeDoc.name}>{activeDoc.name}</span>
                                </div>
                            </div>
                            <button onClick={() => setSelectedCell(null)} className="text-gray-500 hover:text-white p-1 hover:bg-white/10 rounded transition-colors"><X className="w-5 h-5" /></button>
                        </div>

                        {/* Editor Section - Card Style - Detailed */}
                        <div className="p-6 border-b border-white/10 bg-[#111] space-y-4 shrink-0 overflow-y-auto max-h-[50%] custom-scrollbar">
                            <div className="bg-[#1a1a1a] rounded-xl border border-white/5 overflow-hidden">
                                <div className="p-3 border-b border-white/5 flex justify-between items-center bg-white/5">
                                    <span className="font-semibold text-sm text-white">{columns.find(c => c.id === selectedCell.colId)?.title}</span>
                                    {activeCellData.risk_level && (
                                        <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold border ${activeCellData.risk_level === 'High' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                                            activeCellData.risk_level === 'Medium' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
                                                activeCellData.risk_level === 'Low' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                                                    'bg-blue-500/10 text-blue-400 border-blue-500/20'
                                            }`}>{activeCellData.risk_level} Risk</span>
                                    )}
                                </div>
                                <div className="p-4 space-y-4">
                                    <div className="space-y-1">
                                        <label className="text-[10px] text-gray-500 uppercase font-bold tracking-wider block flex items-center gap-1"><Edit3 className="w-3 h-3" /> Analysis</label>
                                        <AutoResizeTextarea
                                            value={activeCellData.value}
                                            onChange={(e) => handleCellUpdate(e.target.value)}
                                            className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-200 focus:border-blue-500 outline-none leading-relaxed transition-colors min-h-[60px]"
                                        />
                                    </div>

                                    {activeCellData.risk_analysis && (
                                        <div className="space-y-1">
                                            <label className="text-[10px] text-gray-500 uppercase font-bold tracking-wider block flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Risk Assessment</label>
                                            <div className="bg-white/5 rounded-lg p-3 border border-white/5">
                                                <p className="text-xs text-gray-300 leading-relaxed">{activeCellData.risk_analysis}</p>
                                            </div>
                                        </div>
                                    )}

                                    {activeCellData.citations && activeCellData.citations.length > 0 && (
                                        <div className="space-y-2">
                                            <label className="text-[10px] text-gray-500 uppercase font-bold tracking-wider block flex items-center gap-1"><Bot className="w-3 h-3" /> Evidence & Citations</label>
                                            <div className="space-y-2">
                                                {activeCellData.citations.map((cite, idx) => (
                                                    <div key={idx} className="group relative">
                                                        <div className="text-[10px] bg-white/5 hover:bg-white/10 text-gray-300 px-3 py-2 rounded border border-white/5 flex items-start gap-2 cursor-pointer transition-colors">
                                                            <span className="shrink-0 mt-0.5 opacity-50">❝</span>
                                                            <span className="italic">{cite}</span>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    <div className="flex gap-2 justify-end pt-2">
                                        <button onClick={() => setSelectedCell(null)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors">Close</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Document Viewer (Fills remaining height) */}
                        <div className="flex-1 bg-slate-900 relative overflow-hidden">
                            {activeDoc.type === 'pdf' ? (
                                <PDFViewer file={activeDoc.fileObj} highlights={activeCellData.citations || []} initialScale={0.7} />
                            ) : (
                                <div className="p-8 text-sm text-gray-300 font-serif whitespace-pre-wrap leading-relaxed max-w-3xl mx-auto h-full overflow-y-auto">{activeDoc.content}</div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* Chat Overlay */}
            {showChat && (
                <div className="absolute bottom-6 right-6 w-96 bg-[#1a1a1a] border border-white/10 rounded-xl shadow-2xl flex flex-col h-[500px] z-50 animate-in slide-in-from-bottom-10">
                    <div className="p-3 border-b border-white/10 flex justify-between items-center bg-[#222] rounded-t-xl">
                        <h3 className="font-bold text-white text-sm flex items-center gap-2"><MessageSquare className="w-4 h-4 text-violet-500" /> Analyst Chat</h3>
                        <button onClick={() => setShowChat(false)}><X className="w-4 h-4 text-gray-400 hover:text-white" /></button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#111]">
                        {chatHistory.map((m, i) => (
                            <div key={i} className={`p-3 rounded-lg text-xs ${m.role === 'user' ? 'bg-violet-600 ml-8 text-white' : 'bg-white/10 mr-8 text-gray-300'}`}>
                                {m.content}
                            </div>
                        ))}
                        {isChatLoading && <div className="text-xs text-gray-500 animate-pulse">Analyzing table data...</div>}
                    </div>
                    <div className="p-3 border-t border-white/10 bg-[#222] rounded-b-xl flex gap-2">
                        <input
                            value={chatInput}
                            onChange={e => setChatInput(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && handleChat()}
                            placeholder="Ask about these contracts..."
                            className="flex-1 bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white outline-none focus:border-violet-500"
                        />
                    </div>
                </div>
            )}

            {/* Add Column Modal */}
            {isAddingCol && (
                <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] backdrop-blur-sm">
                    <div className="bg-[#1a1a1a] rounded-xl border border-white/10 w-[400px] shadow-2xl overflow-hidden">
                        <div className="p-4 border-b border-white/10 bg-[#222] flex justify-between items-center">
                            <h3 className="font-bold text-white">Add Extraction Column</h3>
                            <button onClick={() => setIsAddingCol(false)}><X className="w-4 h-4 text-gray-400 hover:text-white" /></button>
                        </div>
                        <div className="p-6 space-y-5">
                            <div>
                                <label className="text-xs text-gray-400 font-bold block mb-1 uppercase tracking-wider">Column Label</label>
                                <input value={newColTitle} onChange={e => setNewColTitle(e.target.value)} placeholder="e.g. Termination Date" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-blue-500 transition-colors" autoFocus />
                            </div>
                            <div>
                                <label className="text-xs text-gray-400 font-bold block mb-1 uppercase tracking-wider">Extraction Query</label>
                                <textarea value={newColQuery} onChange={e => setNewColQuery(e.target.value)} placeholder="e.g. What is the expiration date of the agreement?" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-white outline-none focus:border-blue-500 h-24 resize-none transition-colors" />
                                <p className="text-[10px] text-gray-500 mt-2">The AI will use this question to extract data from every document.</p>
                            </div>
                        </div>
                        <div className="p-4 border-t border-white/10 bg-[#222] flex justify-end gap-3">
                            <button onClick={() => setIsAddingCol(false)} className="px-4 py-2 text-xs font-medium text-gray-400 hover:text-white transition-colors">Cancel</button>
                            <button onClick={handleAddColumn} disabled={!newColTitle || !newColQuery} className="px-6 py-2 text-xs bg-blue-600 text-white rounded-lg font-bold hover:bg-blue-500 disabled:opacity-50 transition-colors shadow-lg">Create Column</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};