
import { Clause, Template, DocumentFile, TabularData, TabularColumn } from "../types";
import { AIProvider, GenerationOptions } from "./ai/types";
import { GeminiProvider } from "./ai/providers/geminiProvider";
import { OpenAIProvider } from "./ai/providers/openaiProvider";
import { ClaudeProvider } from "./ai/providers/claudeProvider";

// --- Configuration State ---

interface AISettings {
  activeProviderId: string;
  apiKeys: Record<string, string>;
}

let settings: AISettings = {
  activeProviderId: 'gemini',
  apiKeys: {
    gemini: process.env.API_KEY || '',
    openai: '',
    claude: ''
  }
};

let activeProvider: AIProvider | null = null;

export const configureAI = (newSettings: Partial<AISettings>) => {
  settings = { ...settings, ...newSettings };
  settings.apiKeys = { ...settings.apiKeys, ...newSettings.apiKeys }; // Merge keys
  activeProvider = null; // Reset to force re-init
};

const getProvider = (): AIProvider => {
  if (activeProvider) return activeProvider;

  const id = settings.activeProviderId;
  const key = settings.apiKeys[id];

  if (!key) {
    throw new Error(`Missing API Key for ${id}. Please configure it in settings.`);
  }

  switch (id) {
    case 'gemini': activeProvider = new GeminiProvider(key); break;
    case 'openai': activeProvider = new OpenAIProvider(key); break;
    case 'claude': activeProvider = new ClaudeProvider(key); break;
    default: throw new Error(`Unknown provider: ${id}`);
  }

  return activeProvider;
};

// --- Helper Utilities ---

const getRetryDelay = (attempt: number) => 1000 * Math.pow(2, attempt);

async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      console.warn(`AI Attempt ${i + 1} failed:`, e);
      if (i < retries - 1) await new Promise(r => setTimeout(r, getRetryDelay(i)));
    }
  }
  throw lastError;
}

// Helper to convert file to base64 for providers
async function fileToBase64(file: File): Promise<{ mime: string, data: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const base64 = btoa(new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
  return {
    mime: file.type,
    data: base64
  };
}

// --- Business Logic Functions ---

export const generateTemplate = async (
  contractType: string,
  depth: 'Light-Touch' | 'Standard' | 'Detailed',
  verbosity: 'Concise' | 'Standard' | 'Lengthy',
  context?: string
): Promise<Partial<Template>> => {

  const systemPrompt = "You are an expert legal contract architect.";

  const prompt = `
    Create a contract review template for a "${contractType}".
    Context: ${context || 'None'}
    Depth: ${depth}. Verbosity: ${verbosity}.
    
    Return a JSON object with: systemPrompt, formatPrompt, riskTolerance, and clauses array.
    Each clause needs: title, prompt, riskCriteria.
  `;

  // We define the schema for providers that support structured output
  const jsonSchema = {
    type: "object",
    properties: {
      systemPrompt: { type: "string" },
      formatPrompt: { type: "string" },
      riskTolerance: { type: "string" },
      clauses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            prompt: { type: "string" },
            riskCriteria: { type: "string" }
          },
          required: ["title", "prompt", "riskCriteria"],
          additionalProperties: false
        }
      }
    },
    required: ["systemPrompt", "formatPrompt", "riskTolerance", "clauses"],
    additionalProperties: false
  };

  try {
    const provider = getProvider();
    const result = await withRetry(() => provider.generate(prompt, {
      systemPrompt,
      jsonSchema,
      temperature: 0.7
    }));
    return JSON.parse(result);
  } catch (error) {
    console.error("Template Gen Error:", error);
    throw error;
  }
};

export const analyzeContract = async (
  template: Template,
  documents: DocumentFile[],
  isRedacted: boolean = false
): Promise<Record<string, any>> => {

  // Context Prep
  let fullText = documents.map(d => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join("\n\n");
  if (isRedacted) {
    fullText = fullText.replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g, "[REDACTED_EMAIL]");
    // ... other redaction patterns
  }

  // Schema Build
  const findingProperties: any = {};
  template.clauses.forEach(clause => {
    findingProperties[clause.title] = {
      type: "object",
      properties: {
        summary: { type: "string" },
        citations: {
          type: "array",
          items: { type: "string" },
          description: "EXACT VERBATIM QUOTES from the document text supporting this finding. Do not use clause numbers like 'Clause 14.2'. Must be the actual text."
        },
        risk_level: { type: "string", enum: ["High", "Medium", "Low", "Info"] },
        risk_analysis: { type: "string" }
      },
      required: ["summary", "citations", "risk_level", "risk_analysis"],
      additionalProperties: false
    };
  });

  const jsonSchema = {
    type: "object",
    properties: findingProperties,
    required: Object.keys(findingProperties),
    additionalProperties: false
  };

  const isRisk = template.mode === 'risk';
  const clauseInstructions = template.clauses.map(c =>
    `- ${c.title}: ${c.prompt} ${isRisk ? `(Risk Criteria: ${c.riskCriteria || template.riskTolerance})` : ''}`
  ).join("\n");

  const systemPrompt = `${template.systemPrompt}\nRULES: ${template.formatPrompt}\n${isRisk ? `Risk Tol: ${template.riskTolerance}` : ''}`;

  const prompt = `
    CLAUSE INSTRUCTIONS:
    ${clauseInstructions}
    
    DOCUMENT TEXT:
    ${fullText.substring(0, 500000)} 
  `;

  // Multimodal prep
  const useMultimodal = documents.some(d => d.type === 'pdf' || d.type === 'docx');
  let multimodalImages: { mime: string, data: string }[] = [];

  if (useMultimodal) {
    // We need to convert fileObjs to base64
    // Note: In real app, we might need to handle large files carefully.
    // For now we assume the provider can handle the base64 chunks.
    // Only generic provider support required here.
    const images = await Promise.all(documents.map(d => fileToBase64(d.fileObj)));
    multimodalImages = images;
  }

  try {
    const provider = getProvider();
    const result = await withRetry(() => provider.generate(prompt, {
      systemPrompt,
      jsonSchema,
      temperature: 0.1,
      multimodalImages: useMultimodal ? multimodalImages : undefined
    }));
    return JSON.parse(result);
  } catch (error) {
    console.error("Analysis Error:", error);
    throw error;
  }
};

export const chatWithDoc = async (history: string, query: string, context: string): Promise<string> => {
  const systemPrompt = "You are a helpful legal assistant. OUTPUT FORMATTING RULES: 1) Use ## for main sections. 2) Use ### for subsections. 3) Use - for all lists (no numbered lists unless sequential). 4) Bold **key terms**. 5) Keep paragraphs short.";
  const prompt = `
      CONTEXT: ${context.substring(0, 50000)}
      HISTORY: ${history}
      QUERY: ${query}
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, { systemPrompt }));
};

export const draftEmail = async (analysisJson: any): Promise<string> => {
  const systemPrompt = "You are a professional legal consultant.";
  const prompt = `
      Draft a concise email to the client summarizing these findings:
      ${JSON.stringify(analysisJson)}
      Highlight high-risk items first.
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, { systemPrompt }));
};

export const suggestRevision = async (clause: string, original: string, issue: string): Promise<string> => {
  const systemPrompt = "You are an expert contract drafter.";
  const prompt = `
      Clause: ${clause} | Original: "${original}" | Issue: ${issue}
      Rewrite this clause to mitigate the risk while maintaining commercial viability. Return ONLY the text.
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, { systemPrompt }));
};

export const extractTabularData = async (docContent: string, query: string, riskCriteria?: string) => {
  const systemPrompt = "You are an expert legal contract analyst. Output as JSON.";
  const prompt = `
      DOCUMENT TEXT:
      ${docContent.substring(0, 50000)}
      
      ANALYSIS TASK:
      Query: "${query}"
      ${riskCriteria ? `Risk Criteria: ${riskCriteria}` : ''}
      
      INSTRUCTIONS:
      1. Summary: Extract the relevant clause text or answer. Be concise but complete.
      2. Risk: Analyze if this clause presents a risk based on the criteria (or general commercial reasonableness if none provided).
      3. Citations: Extract EXACT VERBATIM SUBSTRINGS from the text that support your finding. They must match the document text characters exactly to allow for highlighting. Do not include surrounding quotation marks in the citation string itself.
      
      Return JSON with:
      - summary (string)
      - citations (string array)
      - risk_level (High/Medium/Low/Info)
      - risk_analysis (string)
    `;

  const jsonSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      citations: { type: "array", items: { type: "string" } },
      risk_level: { type: "string", enum: ["High", "Medium", "Low", "Info"] },
      risk_analysis: { type: "string" }
    },
    required: ["summary", "citations", "risk_level", "risk_analysis"],
    additionalProperties: false
  };

  try {
    const provider = getProvider();
    const result = await withRetry(() => provider.generate(prompt, { systemPrompt, jsonSchema, temperature: 0.1 }));
    const parsed = JSON.parse(result);
    // Map to TabularCell format (value = summary)
    return {
      value: parsed.summary,
      citations: parsed.citations,
      risk_level: parsed.risk_level,
      risk_analysis: parsed.risk_analysis,
      confidence: "High" // Default internal confidence
    };
  } catch (e) {
    return { value: "Error analyzing", citations: [], confidence: "Low", status: "error" };
  }
};

export const analyzeTable = async (data: TabularData, columns: TabularColumn[], query: string): Promise<string> => {
  // Convert table to summary string
  const tableSummary = Object.keys(data).map(docId => {
    const row: any = { DocumentID: docId };
    columns.forEach(col => row[col.title] = data[docId]?.[col.id]?.value || "N/A");
    return row;
  });

  const systemPrompt = "You are a legal analyst reviewing aggregated data.";
  const prompt = `
      Table Data: ${JSON.stringify(tableSummary, null, 2)}
      Query: "${query}"
      Provide insight/summary.
    `;

  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, { systemPrompt }));
};
