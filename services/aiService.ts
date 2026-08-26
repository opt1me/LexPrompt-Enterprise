
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
      if (process.env.DEBUG_AI === 'true') {
        process.stdout.write(`   [withRetry] Attempt ${i + 1}...\n`);
      }
      return await fn();
    } catch (e) {
      lastError = e;
      process.stdout.write(`   ⚠️ [withRetry] Attempt ${i + 1} failed: ${e.message}\n`);
      if (i < retries - 1) {
        const delay = getRetryDelay(i);
        process.stdout.write(`   [withRetry] Retrying in ${delay}ms...\n`);
        await new Promise(r => setTimeout(r, delay));
      }
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

// --- Model Selection Logic ---

type AIUsageTask = 'Reasoning' | 'Extraction' | 'Drafting' | 'Chat';

const getOptimalModelId = (task: AIUsageTask): string | undefined => {
  const providerId = settings.activeProviderId;

  const modelMap: Record<string, Record<AIUsageTask, string>> = {
    gemini: {
      Reasoning: 'gemini-3.0-pro',
      Extraction: 'gemini-3.0-flash',
      Drafting: 'gemini-3.0-flash',
      Chat: 'gemini-3.0-pro'
    },
    openai: {
      Reasoning: 'gpt-5-mini', // Mini is significantly faster for structured architectural tasks
      Extraction: 'gpt-5-mini', // Fast and accurate for legal data
      Drafting: 'gpt-5-mini',
      Chat: 'gpt-5'
    },
    claude: {
      Reasoning: 'claude-opus-4-6',
      Extraction: 'claude-sonnet-4-5', // Better than Haiku for structured extraction
      Drafting: 'claude-haiku-4-5',
      Chat: 'claude-sonnet-4-5'
    }
  };

  return modelMap[providerId]?.[task];
};

// --- Business Logic Functions ---

export const generateTemplate = async (
  contractType: string,
  depth: 'Light-Touch' | 'Standard' | 'Detailed',
  verbosity: 'Concise' | 'Standard' | 'Lengthy',
  context?: string,
  onStatusUpdate?: (status: string) => void
): Promise<Partial<Template>> => {

  const provider = getProvider();

  // Phase 1: Intelligent Planning
  const plannerSystemPrompt = `You are an expert legal contract architect. Your task is to plan a contract review template.
    You must dynamically decide the optimal number of clauses based on the contract type and depth:
    - Light-Touch: ~8-12 high-level commercial risks.
    - Standard: ~15-22 balanced legal and commercial points.
    - Detailed: ~25-35 deep-dive technical nuances (only where truly relevant).
    
    Do not use a hard limit; use your legal judgment to ensure the template is comprehensive but efficient for the "${contractType}".`;

  const plannerPrompt = `
    Create a plan for a "${depth}" contract review template for a "${contractType}".
    Context: ${context || 'None'}
    Verbosity: ${verbosity}.
    
    Return a JSON object with: 
    1. systemPrompt: General instructions for the AI reviewer.
    2. formatPrompt: Technical formatting instructions.
    3. riskTolerance: A description of what constitutes high/medium risk for this contract.
    4. clausePlans: Array of { title, instructionSummary, riskCriteriaSummary } for each relevant clause.
  `;

  const plannerSchema = {
    type: "object",
    properties: {
      systemPrompt: { type: "string" },
      formatPrompt: { type: "string" },
      riskTolerance: { type: "string" },
      clausePlans: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            instructionSummary: { type: "string" },
            riskCriteriaSummary: { type: "string" }
          },
          required: ["title", "instructionSummary", "riskCriteriaSummary"],
          additionalProperties: false
        }
      }
    },
    required: ["systemPrompt", "formatPrompt", "riskTolerance", "clausePlans"],
    additionalProperties: false
  };

  try {
    onStatusUpdate?.(`Architecting ${depth} template for ${contractType}...`);
    const planResult = await withRetry(() => provider.generate(plannerPrompt, {
      systemPrompt: plannerSystemPrompt,
      jsonSchema: plannerSchema,
      temperature: 0.7,
      modelId: getOptimalModelId('Reasoning')
    }));
    const plan = JSON.parse(planResult);

    // Phase 2: Simultaneous Parallel Generation
    onStatusUpdate?.(`Template planned with ${plan.clausePlans.length} clauses. Generating prompts simultaneously...`);

    const fastModelId = getOptimalModelId('Drafting');

    // Process ALL clauses simultaneously using Promise.all
    // We can use a simple limiter if needed, but modern APIs handle 20-30 concurrent fine.
    const clauses = await Promise.all(plan.clausePlans.map(async (cp: any, index: number) => {
      const generationPrompt = `
        Generate a comprehensive legal prompt for the clause: "${cp.title}".
        Context: ${cp.instructionSummary}
        Risk Criteria: ${cp.riskCriteriaSummary}
        Verbosity Level: ${verbosity}
        
        Return JSON: { prompt: "string", riskCriteria: "string" }
      `;

      const clauseSchema = {
        type: "object",
        properties: {
          prompt: { type: "string" },
          riskCriteria: { type: "string" }
        },
        required: ["prompt", "riskCriteria"],
        additionalProperties: false
      };

      const result = await withRetry(() => provider.generate(generationPrompt, {
        systemPrompt: "You are a legal prompt engineer.",
        jsonSchema: clauseSchema,
        temperature: 0.5,
        modelId: fastModelId
      }));

      const generated = JSON.parse(result);
      return {
        title: cp.title,
        prompt: generated.prompt,
        riskCriteria: generated.riskCriteria
      };
    }));

    onStatusUpdate?.("Finalizing template...");

    return {
      systemPrompt: plan.systemPrompt,
      formatPrompt: plan.formatPrompt,
      riskTolerance: plan.riskTolerance,
      clauses
    };

  } catch (error: any) {
    console.error("Template Gen Error:", error);
    if (error.message.includes("API Key")) {
      throw new Error("Missing API Key. Please configure it in Settings.");
    }
    throw new Error("Failed to generate template. Check your API key and try again.");
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

    INSTRUCTION: If the "DOCUMENT TEXT" above is empty or incomplete, it is likely a scanned document. 
    In this case, use the attached images or PDF file providing the visual content for your analysis.
  `;

  // Multimodal prep & OCR Support
  const provider = getProvider();
  let multimodalImages: { mime: string, data: string }[] = [];
  let multimodalFiles: { mime: string, data: string, name: string }[] = [];

  for (const d of documents) {
    if (d.images && d.images.length > 0) {
      // Scanned PDF - use the pre-rendered images for native AI OCR
      multimodalImages.push(...d.images);
    } else if (d.type === 'pdf') {
      const fileData = await fileToBase64(d.fileObj);
      if (provider.id === 'gemini' || provider.id === 'openai') {
        // Both Gemini and modern OpenAI (GPT-4o) handle PDFs directly
        multimodalFiles.push({ mime: 'application/pdf', data: fileData.data, name: d.name });
      }
    } else if (d.type === 'docx') {
      if (provider.id === 'gemini') {
        const fileData = await fileToBase64(d.fileObj);
        multimodalFiles.push({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', data: fileData.data, name: d.name });
      }
    }
  }

  const useMultimodal = multimodalImages.length > 0 || multimodalFiles.length > 0;

  try {
    const result = await withRetry(() => provider.generate(prompt, {
      systemPrompt,
      jsonSchema,
      temperature: 0.1,
      modelId: getOptimalModelId('Reasoning'),
      multimodalImages: multimodalImages.length > 0 ? multimodalImages : undefined,
      multimodalFiles: multimodalFiles.length > 0 ? multimodalFiles : undefined
    }));
    return JSON.parse(result);
  } catch (error) {
    console.error("Analysis Error:", error);
    throw error;
  }
};

export const chatWithDoc = async (
  history: string,
  query: string,
  context: string,
  onStream?: (chunk: string) => void
): Promise<string> => {
  const systemPrompt = "You are a helpful legal assistant. OUTPUT FORMATTING RULES: 1) Use ## for main sections. 2) Use ### for subsections. 3) Use - for all lists (no numbered lists unless sequential). 4) Bold **key terms**. 5) Keep paragraphs short. ALWAYS provide detailed reasoning based on CONTEXT.";
  const prompt = `
      CONTEXT: ${context.substring(0, 50000)}
      HISTORY: ${history}
      QUERY: ${query}
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, {
    systemPrompt,
    modelId: getOptimalModelId('Chat'),
    onStream
  }));
};

export const draftEmail = async (analysisJson: any): Promise<string> => {
  const systemPrompt = "You are a professional legal consultant.";
  const prompt = `
      Draft a concise email to the client summarizing these findings:
      ${JSON.stringify(analysisJson)}
      Highlight high-risk items first.
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, {
    systemPrompt,
    modelId: getOptimalModelId('Drafting')
  }));
};

export const suggestRevision = async (clause: string, original: string, issue: string): Promise<string> => {
  const systemPrompt = "You are an expert contract drafter.";
  const prompt = `
      Clause: ${clause} | Original: "${original}" | Issue: ${issue}
      Rewrite this clause to mitigate the risk while maintaining commercial viability. Return ONLY the text.
    `;
  const provider = getProvider();
  return await withRetry(() => provider.generate(prompt, {
    systemPrompt,
    modelId: getOptimalModelId('Reasoning')
  }));
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
    const result = await withRetry(() => provider.generate(prompt, {
      systemPrompt,
      jsonSchema,
      temperature: 0.1,
      modelId: getOptimalModelId('Extraction')
    }));
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
  return await withRetry(() => provider.generate(prompt, {
    systemPrompt,
    modelId: getOptimalModelId('Reasoning')
  }));
};
