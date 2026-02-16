
import React, { useState, useEffect, useRef } from 'react';
import { ActivityEvent, AnalysisResult, DocumentFile, ChatMessage, Comment, FindingReviewStatus, FindingComment } from '../types';
import { PDFViewer } from './PDFViewer';
import { Mail, FileDown, ShieldAlert, Wand2, MousePointerClick, MessageSquare, Loader, MessageCircle, Send, User, CheckCircle, FileText, AlignLeft, AlertCircle, Link2 } from 'lucide-react';

// Access docx library from window (loaded via CDN)
declare const docx: any;

interface ResultsViewProps {
  results: AnalysisResult[];
  documents: DocumentFile[];
  onDraftEmail: (data: any) => Promise<void>;
  onSuggestRevision: (clause: string, original: string, issue: string) => void;
  onChat: (query: string) => Promise<string>;
  loadingAi: boolean;
  userCredits: number;
  onConsumeCredits: (cost: number) => boolean;
  workspaceId?: string;
  activity?: ActivityEvent[];
  findingComments?: Record<string, FindingComment[]>;
  findingStatuses?: Record<string, { status: FindingReviewStatus; version: number }>;
  onAddFindingComment?: (resultId: string, clauseKey: string, text: string) => Promise<FindingComment[]>;
  onGetFindingComments?: (resultId: string, clauseKey: string) => Promise<FindingComment[]>;
  onUpdateFindingStatus?: (resultId: string, clauseKey: string, status: FindingReviewStatus) => Promise<void>;
  onHydrateFindingStatus?: (resultId: string, clauseKey: string) => Promise<void>;
  onCopyReviewLink?: () => void;
}

const COSTS = {
    CHAT: 1,
    REVISION: 5,
    EMAIL: 2,
};

export const ResultsView: React.FC<ResultsViewProps> = ({ 
    results, documents, onDraftEmail, onSuggestRevision, onChat, loadingAi, userCredits, onConsumeCredits,
    workspaceId, activity = [], findingComments = {}, findingStatuses = {},
    onAddFindingComment, onGetFindingComments, onUpdateFindingStatus, onHydrateFindingStatus, onCopyReviewLink
}) => {
    const [activeResultIdx, setActiveResultIdx] = useState(0);
    const [activeDocIdx, setActiveDocIdx] = useState(0);
    const [highlights, setHighlights] = useState<string[]>([]);
    const [tab, setTab] = useState<'findings' | 'chat' | 'viewer'>('findings');
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [chatInput, setChatInput] = useState("");
    const [chatLoading, setChatLoading] = useState(false);
    const [commentInputs, setCommentInputs] = useState<Record<string, string>>({});
    const [openDiscussion, setOpenDiscussion] = useState<string | null>(null);
    const [isExporting, setIsExporting] = useState(false);
    const [citationToast, setCitationToast] = useState<string | null>(null);
    
    const chatEndRef = useRef<HTMLDivElement>(null);
    const [generatingRevisionFor, setGeneratingRevisionFor] = useState<string | null>(null);

    const activeResult = results[activeResultIdx];
    const currentDoc = activeResult ? documents[activeResult.docIndices[activeDocIdx] || 0] : null;

    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [chatHistory]);
    
    useEffect(() => {
        if (!loadingAi) {
            setGeneratingRevisionFor(null);
        }
    }, [loadingAi]);

    useEffect(() => {
        if (!activeResult || !onHydrateFindingStatus) return;
        Object.keys(activeResult.data).forEach((clauseKey) => {
            onHydrateFindingStatus(activeResult.id, clauseKey);
        });
    }, [activeResult?.id]);

    const handleCitationClick = (citations: string[]) => {
        setHighlights(citations);
        setCitationToast(null);
        
        // Mobile fix: If we are on a small screen, switch to the 'viewer' tab automatically
        // so the user can see the highlight in the document.
        if (window.innerWidth < 1024) {
            setTab('viewer');
        }
    };

    const handleHighlightResult = (matches: number) => {
        if (!highlights.length) return;
        if (matches === 0) {
            setCitationToast("No exact match found for citation");
            setTimeout(() => setCitationToast(null), 3000);
            return;
        }
        setCitationToast(null);
    };

    const truncateCitation = (citation: string): string => {
        if (citation.length <= 72) return citation;
        return `${citation.slice(0, 69)}...`;
    };

    const buildRiskOverview = (item: any): string => {
        const aiRisk = String(item?.risk_analysis || "").trim();
        if (aiRisk) return aiRisk;

        const level = String(item?.risk_level || "Info");
        const summary = String(item?.summary || "").trim();
        const clippedSummary = summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;

        if (level === "High") {
            return `High risk due to adverse or incomplete clause terms. ${clippedSummary}`.trim();
        }
        if (level === "Medium") {
            return `Medium risk due to potentially unfavorable wording or missing precision. ${clippedSummary}`.trim();
        }
        if (level === "Low") {
            return `Low risk overall, but this clause should still be confirmed in context. ${clippedSummary}`.trim();
        }
        return `Informational finding with no material risk trigger identified. ${clippedSummary}`.trim();
    };

    const handleSendChat = async () => {
        if (!chatInput.trim()) return;
        if (!onConsumeCredits(COSTS.CHAT)) return; 

        const query = chatInput;
        setChatInput("");
        setChatHistory(prev => [...prev, { role: 'user', content: query }]);
        setChatLoading(true);
        try {
            const resp = await onChat(query);
            setChatHistory(prev => [...prev, { role: 'assistant', content: resp }]);
        } catch (e) {
            setChatHistory(prev => [...prev, { role: 'assistant', content: "Error processing request." }]);
        }
        setChatLoading(false);
    };

    const findingIdFor = (clauseTitle: string) => `${activeResult.id}:${clauseTitle}`;

    const handleAddComment = async (clauseTitle: string) => {
        const text = commentInputs[clauseTitle];
        if (!text?.trim()) return;

        try {
            if (onAddFindingComment) {
                const remoteComments = await onAddFindingComment(activeResult.id, clauseTitle, text);
                if (activeResult.data[clauseTitle]) {
                    activeResult.data[clauseTitle].comments = remoteComments.map((c) => ({
                        id: c.id,
                        author: c.authorEmail,
                        text: c.text,
                        timestamp: new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                        role: 'reviewer'
                    }));
                }
            }
        } catch {
            // fallback local comment on API failure
            const newComment: Comment = {
                id: Math.random().toString(36).substr(2, 9),
                author: "Enterprise Reviewer",
                text: text,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                role: 'reviewer'
            };
            if (activeResult.data[clauseTitle]) {
                const existingComments = activeResult.data[clauseTitle].comments || [];
                activeResult.data[clauseTitle].comments = [...existingComments, newComment];
            }
        }
        setCommentInputs(prev => ({ ...prev, [clauseTitle]: "" }));
    };

    const handleSetStatus = async (clauseTitle: string, status: FindingReviewStatus) => {
        try {
            if (onUpdateFindingStatus) {
                await onUpdateFindingStatus(activeResult.id, clauseTitle, status);
            }
            if (activeResult.data[clauseTitle]) {
                activeResult.data[clauseTitle].collaborationStatus = status;
                activeResult.data[clauseTitle].reviewedBy = status === 'approved' ? "Senior Counsel" : undefined;
            }
            setOpenDiscussion(null);
        } catch {
            // optimistic-lock conflicts should not break session flow
        }
    };

    const handleSuggestRevisionClick = (key: string, original: string, issue: string) => {
        if (!onConsumeCredits(COSTS.REVISION)) return;
        setGeneratingRevisionFor(key);
        onSuggestRevision(key, original, issue);
    };

    const handleEmailClick = async () => {
        if (!onConsumeCredits(COSTS.EMAIL)) return;
        onDraftEmail(activeResult.data);
    };

    const handleExport = async () => {
        // Access docx through window.docx (CDN loaded library)
        const docxLib = (window as any).docx;
        if (!activeResult || !docxLib) {
            console.error("docx library not loaded from CDN");
            alert("Export library is still loading. Please wait a moment.");
            return;
        }
        
        setIsExporting(true);

        try {
            const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docxLib;

            const sections = [];
            
            // Document Header
            sections.push(
                new Paragraph({
                    text: "LEXPROMPT ENTERPRISE ANALYSIS",
                    heading: HeadingLevel.HEADING_1,
                    alignment: AlignmentType.CENTER,
                    spacing: { after: 400 }
                }),
                new Paragraph({
                    children: [
                        new TextRun({ text: "Generated on: ", bold: true }),
                        new TextRun(new Date().toLocaleString()),
                    ],
                }),
                        new Paragraph({
                            children: [
                                new TextRun({ text: "Analysis Model: ", bold: true }),
                                new TextRun(activeResult.modelUsed || "Gemini 2.5 Flash-Lite"),
                            ],
                            spacing: { after: 400 }
                        })
            );

            // Detailed Findings
            Object.entries(activeResult.data).forEach(([key, item]: [string, any]) => {
                sections.push(
                    new Paragraph({
                        text: key.toUpperCase(),
                        heading: HeadingLevel.HEADING_2,
                        spacing: { before: 200, after: 120 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "RISK LEVEL: ", bold: true }),
                            new TextRun({ 
                                text: (item.risk_level || "Info").toUpperCase(), 
                                color: item.risk_level === 'High' ? "D11149" : item.risk_level === 'Medium' ? "E98B14" : "2A9D8F" 
                            }),
                        ],
                        spacing: { after: 100 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "EXECUTIVE SUMMARY: ", bold: true }),
                            new TextRun(item.summary),
                        ],
                        spacing: { after: 100 }
                    })
                );

                if (item.risk_analysis) {
                    sections.push(
                        new Paragraph({
                            children: [
                                new TextRun({ text: "RISK ANALYSIS: ", bold: true, italics: true }),
                                new TextRun(item.risk_analysis),
                            ],
                            spacing: { after: 100 }
                        })
                    );
                }

                if (item.citations && item.citations.length > 0) {
                    sections.push(new Paragraph({ text: "VERBATIM CITATIONS:", bold: true, spacing: { before: 100 } }));
                    item.citations.forEach((citation: string) => {
                        sections.push(
                            new Paragraph({
                                text: `"${citation}"`,
                                bullet: { level: 0 },
                                spacing: { after: 100 }
                            })
                        );
                    });
                }
                
                // Horizontal divider logic (spacing)
                sections.push(new Paragraph({ text: "", spacing: { after: 200 } }));
            });

            const doc = new Document({
                sections: [{
                    children: sections
                }],
            });

            const blob = await Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `LexPrompt_Report_${activeResult.title.replace(/\s+/g, '_')}_${new Date().getTime()}.docx`;
            a.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Export process failed", error);
            alert("Error generating .docx file. See console for technical details.");
        } finally {
            setIsExporting(false);
        }
    };

    if (!activeResult) return <div className="text-white p-8">No results available for display.</div>;

    return (
        <div className="flex flex-col lg:flex-row h-[calc(100vh-64px)] bg-[#09090b]">
            {/* Sidebar: Findings & Chat */}
            <div className={`w-full lg:w-1/3 border-r border-white/10 flex flex-col bg-[#111] h-full overflow-hidden ${tab === 'viewer' ? 'hidden lg:flex' : 'flex'}`}>
                <div className="flex border-b border-white/10 shrink-0">
                    <button onClick={() => setTab('findings')} className={`flex-1 py-3 text-sm font-black transition-colors ${tab === 'findings' ? 'text-violet-400 border-b-2 border-violet-500 bg-violet-500/5' : 'text-gray-500 hover:text-gray-300'}`}>ANALYSIS</button>
                    <button onClick={() => setTab('chat')} className={`flex-1 py-3 text-sm font-black transition-colors ${tab === 'chat' ? 'text-violet-400 border-b-2 border-violet-500 bg-violet-500/5' : 'text-gray-500 hover:text-gray-300'}`}>ASSISTANT</button>
                    {/* Viewer tab toggle for mobile */}
                    <button onClick={() => setTab('viewer')} className="lg:hidden flex-1 py-3 text-sm font-black transition-colors text-gray-500 hover:text-gray-300">DOCUMENT</button>
                </div>

                {tab === 'findings' ? (
                    <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-[#0d0d0f]">
                        <div className="flex justify-between items-center mb-6 shrink-0">
                            <h3 className="font-black text-white text-lg tracking-tight">Review Findings</h3>
                            <div className="flex gap-2">
                                <button onClick={handleEmailClick} className="p-2.5 bg-white/5 rounded-xl hover:bg-white/10 text-white relative group border border-white/5 transition-all" title="Draft Email Summary (2c)">
                                    <Mail className="w-5 h-5" />
                                    <span className="absolute -top-1 -right-1 bg-violet-600 text-[8px] font-bold px-1.5 py-0.5 rounded-full ring-2 ring-[#0d0d0f]">{COSTS.EMAIL}c</span>
                                </button>
                                {onCopyReviewLink && (
                                    <button
                                        onClick={onCopyReviewLink}
                                        className="p-2.5 bg-white/5 rounded-xl hover:bg-white/10 text-white border border-white/5 transition-all"
                                        title="Copy Review Link"
                                    >
                                        <Link2 className="w-5 h-5" />
                                    </button>
                                )}
                                <button 
                                    onClick={handleExport} 
                                    disabled={isExporting}
                                    className="p-2.5 bg-violet-600 rounded-xl hover:bg-violet-500 text-white border border-violet-400/20 shadow-lg shadow-violet-900/20 transition-all disabled:opacity-50"
                                    title="Export to Word (.docx)"
                                >
                                    {isExporting ? <Loader className="w-5 h-5 animate-spin" /> : <FileDown className="w-5 h-5" />}
                                </button>
                            </div>
                        </div>
                        {Object.entries(activeResult.data).map(([key, item]: [string, any]) => {
                            const fid = findingIdFor(key);
                            const liveStatus = findingStatuses[fid]?.status || item.collaborationStatus || 'open';
                            const mergedComments = (findingComments[fid] || []).map((c) => ({
                                id: c.id,
                                author: c.authorEmail,
                                text: c.text,
                                timestamp: new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                role: 'reviewer' as const
                            }));
                            const commentsForRender = mergedComments.length > 0 ? mergedComments : (item.comments || []);
                            const riskOverview = buildRiskOverview(item);
                            const riskTone = item.risk_level === 'High'
                                ? 'bg-red-500/5 border-red-500/15 text-red-300'
                                : item.risk_level === 'Medium'
                                ? 'bg-yellow-500/5 border-yellow-500/15 text-yellow-200'
                                : 'bg-emerald-500/5 border-emerald-500/15 text-emerald-200';
                            return (
                            <div key={key} className={`bg-[#161618] rounded-2xl border transition-all hover:shadow-2xl ${item.reviewedBy ? 'border-green-500/20' : 'border-white/5 hover:border-violet-500/30'}`}>
                                <div className="p-4 border-b border-white/5 flex justify-between items-center bg-white/5 rounded-t-2xl">
                                    <div className="flex items-center gap-2">
                                        <span className="font-black text-xs text-white uppercase tracking-wider">{key}</span>
                                        {item.reviewedBy && <CheckCircle className="w-3.5 h-3.5 text-green-500" />}
                                    </div>
                                    {item.risk_level && (
                                        <span className={`text-[10px] px-2.5 py-1 rounded-lg uppercase font-black ${
                                            item.risk_level === 'High' ? 'bg-red-500/20 text-red-400 border border-red-500/30' :
                                            item.risk_level === 'Medium' ? 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30' : 'bg-green-500/20 text-green-400 border border-green-500/30'
                                        }`}>{item.risk_level}</span>
                                    )}
                                </div>
                                <div className="p-5 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[10px] uppercase tracking-widest text-gray-500 font-black">Status</span>
                                        <div className="flex gap-1.5">
                                            {(['open', 'needs-review', 'approved'] as FindingReviewStatus[]).map((s) => (
                                                <button
                                                    key={s}
                                                    onClick={() => handleSetStatus(key, s)}
                                                    className={`text-[10px] px-2 py-1 rounded-md uppercase font-black ${
                                                        liveStatus === s ? 'bg-violet-600 text-white' : 'bg-white/5 text-gray-400'
                                                    }`}
                                                >
                                                    {s}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <div className="text-[10px] text-gray-500 font-black tracking-widest uppercase">Clause Summary</div>
                                        <p className="text-sm text-gray-300 leading-relaxed font-medium">{item.summary}</p>
                                    </div>
                                    
                                    <div className={`p-4 rounded-xl border space-y-2 ${riskTone}`}>
                                        <div className="text-[10px] font-black tracking-widest flex items-center gap-1.5 uppercase"><ShieldAlert className="w-4 h-4"/> Risk Overview</div>
                                        <p className="text-xs leading-relaxed italic">"{riskOverview}"</p>
                                        {(item.risk_level === 'High' || item.risk_level === 'Medium') && (
                                            <button 
                                                onClick={() => handleSuggestRevisionClick(key, item.citations[0] || item.summary, riskOverview)}
                                                className="mt-3 w-full py-2 text-xs bg-red-500/10 text-red-300 rounded-lg hover:bg-red-500/20 border border-red-500/10 flex items-center justify-center gap-2 transition-all font-bold"
                                            >
                                                {generatingRevisionFor === key ? <><Loader className="w-3 h-3 animate-spin" /> Generating...</> : <><Wand2 className="w-4 h-4" /> Mitigate with AI ({COSTS.REVISION}c)</>}
                                            </button>
                                        )}
                                    </div>

                                    <div className="flex flex-wrap gap-2">
                                        {item.citations?.map((c: string, i: number) => (
                                            <button key={i} title={c} onClick={() => handleCitationClick([c])} className="text-[10px] bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white px-3 py-1.5 rounded-lg border border-white/5 flex items-center gap-2 transition-all font-bold max-w-full">
                                                <MousePointerClick className="w-3 h-3 shrink-0" />
                                                <span>VERBATIM REF {i+1}</span>
                                                <span className="text-[10px] text-gray-500 normal-case truncate max-w-[180px]">{truncateCitation(c)}</span>
                                            </button>
                                        ))}
                                    </div>

                                    <div className="pt-4 border-t border-white/5 mt-4">
                                        <div className="flex justify-between items-center mb-3">
                                            <button 
                                                onClick={() => setOpenDiscussion(openDiscussion === key ? null : key)}
                                                className="text-[11px] font-black uppercase tracking-wider text-gray-500 hover:text-violet-400 flex items-center gap-1.5 transition-all"
                                            >
                                                <MessageCircle className="w-4 h-4" /> 
                                                {commentsForRender?.length || 0} Discussions 
                                            </button>
                                            {liveStatus !== 'approved' && (
                                                <button onClick={() => handleSetStatus(key, 'approved')} className="text-[10px] text-green-500/60 hover:text-green-400 font-black uppercase tracking-wider transition-all">Mark as Reviewed</button>
                                            )}
                                        </div>
                                        
                                        {openDiscussion === key && (
                                            <div className="mt-4 space-y-4 animate-in slide-in-from-top-2">
                                                <div className="space-y-3 max-h-56 overflow-y-auto pr-2 custom-scrollbar">
                                                    {commentsForRender?.map((c: Comment) => (
                                                        <div key={c.id} className="bg-black/20 p-3 rounded-2xl border border-white/5 shadow-inner">
                                                            <div className="flex justify-between items-center mb-1 text-gray-500">
                                                                <span className="font-black text-[9px] uppercase flex items-center gap-1.5 text-violet-400"><User className="w-3 h-3"/> {c.author}</span>
                                                                <span className="text-[9px] font-medium">{c.timestamp}</span>
                                                            </div>
                                                            <p className="text-xs text-gray-300 leading-relaxed font-medium">{c.text}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                                <div className="flex gap-2">
                                                    <input 
                                                        value={commentInputs[key] || ""}
                                                        onChange={(e) => setCommentInputs(prev => ({ ...prev, [key]: e.target.value }))}
                                                        onFocus={() => onGetFindingComments?.(activeResult.id, key)}
                                                        onKeyDown={(e) => e.key === 'Enter' && handleAddComment(key)}
                                                        placeholder="Post a comment... use @email for mentions"
                                                        className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-xs text-white outline-none focus:border-violet-500 transition-all font-medium"
                                                    />
                                                    <button 
                                                        onClick={() => handleAddComment(key)}
                                                        className="p-2.5 bg-violet-600 rounded-xl text-white hover:bg-violet-500 transition-all shadow-lg shadow-violet-900/20"
                                                    >
                                                        <Send className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        )})}
                        {workspaceId && (
                            <div className="bg-[#161618] rounded-2xl border border-white/5 p-4">
                                <div className="text-[10px] uppercase tracking-widest font-black text-gray-500 mb-2">Activity Timeline</div>
                                <div className="space-y-2 max-h-52 overflow-y-auto pr-2">
                                    {activity.length === 0 && <div className="text-xs text-gray-500">No activity yet.</div>}
                                    {activity.slice(0, 20).map((ev) => (
                                        <div key={ev.id} className="text-xs bg-black/30 border border-white/5 rounded-lg p-2">
                                            <div className="text-gray-300"><span className="text-violet-300 font-bold">{ev.actorEmail}</span> {ev.type.replace(/_/g, " ")}</div>
                                            <div className="text-[10px] text-gray-500">{new Date(ev.createdAt).toLocaleString()}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                ) : tab === 'chat' ? (
                    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#0d0d0f]">
                        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
                            {chatHistory.map((m, i) => (
                                <div key={i} className={`p-4 rounded-[20px] text-sm leading-relaxed max-w-[85%] font-medium ${m.role === 'user' ? 'ml-auto bg-violet-600 text-white shadow-xl shadow-violet-900/20' : 'bg-[#1a1a1c] text-gray-300 border border-white/5'}`}>
                                    {m.content}
                                </div>
                            ))}
                            {chatLoading && <div className="p-4 text-gray-500 text-xs animate-pulse flex items-center gap-2 font-bold tracking-widest"><Loader className="w-4 h-4 animate-spin" /> COUNSEL THINKING...</div>}
                            <div ref={chatEndRef} />
                        </div>
                        <div className="p-6 border-t border-white/10 shrink-0 bg-[#111]">
                            <div className="flex gap-3">
                                <input 
                                    value={chatInput} 
                                    onChange={e => setChatInput(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                                    placeholder="Ask about this specific contract..."
                                    className="flex-1 bg-black/50 border border-white/10 rounded-2xl px-5 py-3 text-sm text-white focus:outline-none focus:border-violet-500 transition-all shadow-inner"
                                />
                                <button onClick={handleSendChat} disabled={chatLoading} className="p-3 bg-violet-600 text-white rounded-2xl hover:bg-violet-500 transition-all shadow-2xl shadow-violet-900/40 active:scale-95">
                                    <MessageSquare className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    </div>
                ) : null}
            </div>

            {/* Document Viewer (Main viewport) */}
            <div className={`flex-1 bg-[#09090b] relative flex flex-col h-full overflow-hidden ${tab !== 'viewer' ? 'hidden lg:flex' : 'flex'}`}>
                <div className="h-12 bg-[#161618] border-b border-white/5 flex items-center justify-between px-6 shrink-0 shadow-sm z-10">
                    <div className="flex items-center gap-3 overflow-hidden">
                        {/* Mobile back navigation to findings */}
                        <div className="lg:hidden">
                            <button onClick={() => setTab('findings')} className="p-1.5 bg-white/5 rounded text-gray-400 mr-2 flex items-center gap-1">
                                <AlignLeft className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="w-6 h-6 bg-violet-500/10 rounded flex items-center justify-center"><FileText className="w-3.5 h-3.5 text-violet-400" /></div>
                        <span className="text-xs text-gray-400 font-black uppercase tracking-widest truncate">{currentDoc?.name || "Active Document"}</span>
                    </div>
                    <div className="flex items-center gap-4">
                        <div className="hidden md:flex items-center gap-2 text-[10px] uppercase tracking-widest">
                            {activeResult.providerUsed && <span className="text-cyan-400 font-black">{activeResult.providerUsed}</span>}
                            {activeResult.modelUsed && <span className="text-gray-500">{activeResult.modelUsed}</span>}
                            {activeResult.regionUsed && <span className="text-emerald-400 font-black">{activeResult.regionUsed}</span>}
                        </div>
                        {activeResult.docIndices.length > 1 && (
                            <select 
                                className="bg-black/50 text-[10px] font-black uppercase tracking-wider text-gray-300 border border-white/10 rounded-lg px-3 py-1.5 outline-none cursor-pointer hover:border-violet-500/50 transition-all"
                                onChange={(e) => setActiveDocIdx(Number(e.target.value))}
                                value={activeDocIdx}
                            >
                                {activeResult.docIndices.map((idx, i) => (
                                    <option key={i} value={i}>{documents[idx].name}</option>
                                ))}
                            </select>
                        )}
                        <button className="lg:hidden text-[10px] text-violet-400 font-black uppercase tracking-widest px-2" onClick={() => setTab('findings')}>Findings</button>
                    </div>
                </div>
                <div className="flex-1 overflow-hidden relative bg-[#1c1c1e]">
                    {currentDoc?.type === 'pdf' ? (
                        <PDFViewer file={currentDoc.fileObj} highlights={highlights} initialScale={1.3} onHighlightResult={handleHighlightResult} />
                    ) : (
                        <div className="p-12 whitespace-pre-wrap font-serif text-base text-gray-300 max-w-4xl mx-auto overflow-y-auto h-full bg-[#161618] shadow-[0_0_100px_rgba(0,0,0,0.5)] my-8 rounded-2xl border border-white/5 custom-scrollbar leading-loose">
                            {currentDoc?.content}
                        </div>
                    )}
                </div>
            </div>
            {citationToast && (
                <div className="fixed bottom-8 right-8 px-4 py-2 rounded-xl border border-red-500/40 bg-red-950/90 text-red-100 text-xs font-bold flex items-center gap-2 z-[90]">
                    <AlertCircle className="w-4 h-4" />
                    {citationToast}
                </div>
            )}
        </div>
    );
};
