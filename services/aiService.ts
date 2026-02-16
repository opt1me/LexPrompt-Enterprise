
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Clause, Template, DocumentFile, TabularData, TabularColumn, AIProvider } from "../types";

export const AVAILABLE_MODELS = {
    // Google Gemini
    GEMINI_3_FLASH: 'gemini-3-flash-preview',
    GEMINI_3_PRO: 'gemini-3-pro-preview',
    
    // OpenAI
    GPT_4O: 'gpt-4o',
    GPT_4O_MINI: 'gpt-4o-mini',
    O1_PREVIEW: 'o1-preview',
    O3_MINI: 'o3-mini',

    // Anthropic
    CLAUDE_3_7_SONNET: 'claude-3-7-sonnet-latest',
    CLAUDE_3_5_SONNET: 'claude-3-5-sonnet-latest',
    CLAUDE_3_5_HAIKU: 'claude-3-5-haiku-latest'
};

const getProvider = (model: string): AIProvider => {
    if (model.includes('gemini')) return 'google';
    if (model.includes('gpt') || model.startsWith('o')) return 'openai';
    if (model.includes('claude')) return 'anthropic';
    return 'google';
};

const getApiKey = (provider: AIProvider): string | undefined => {
    const savedKeys = localStorage.getItem('lexprompt_api_keys');
    if (savedKeys) {
        const keys = JSON.parse(savedKeys);
        if (keys[provider]) return keys[provider];
    }
    // Fallback for Gemini environment key
    if (provider === 'google') return process.env.API_KEY;
    return undefined;
};

/**
 * Universal Content Generator
 * Routes requests to Gemini (SDK) or OpenAI/Anthropic (Fetch)
 */
const generateUniversalContent = async (params: {
    model: string;
    system?: string;
    prompt: string;
    responseSchema?: any;
    temperature?: number;
    thinkingBudget?: number;
}) => {
    const provider = getProvider(params.model);
    const apiKey = getApiKey(provider);

    if (!apiKey) throw new Error(`Missing API Key for ${provider.toUpperCase()}. Please configure in Settings.`);

    if (provider === 'google') {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: params.model,
            contents: params.prompt,
            config: {
                systemInstruction: params.system,
                responseMimeType: params.responseSchema ? "application/json" : "text/plain",
                responseSchema: params.responseSchema,
                temperature: params.temperature ?? 0.1,
                ...(params.thinkingBudget ? { thinkingConfig: { thinkingBudget: params.thinkingBudget } } : {})
            }
        });
        return response.text;
    }

    if (provider === 'openai') {
        // Handle O1/O3 models (they often don't support system messages in standard way)
        const isReasoning = params.model.startsWith('o');
        const messages = [];
        if (params.system && !isReasoning) {
            messages.push({ role: "system", content: params.system });
        }
        messages.push({ role: "user", content: params.prompt });

        const body: any = {
            model: params.model,
            messages,
            ...(params.responseSchema ? { 
                response_format: { type: "json_object" } 
            } : {}),
            ...(!isReasoning ? { temperature: params.temperature ?? 0.1 } : {})
        };

        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || "OpenAI API Error");
        }
        const data = await res.json();
        return data.choices[0].message.content;
    }

    if (provider === 'anthropic') {
        const body: any = {
            model: params.model,
            max_tokens: 4096,
            messages: [{ role: "user", content: params.prompt }],
            system: params.system,
            temperature: params.temperature ?? 0.1
        };

        const res = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error?.message || "Anthropic API Error");
        }
        const data = await res.json();
        return data.content[0].text;
    }

    throw new Error("Unsupported Provider");
};

export const generateTemplate = async (
  contractType: string,
  depth: string,
  verbosity: string,
  context?: string
): Promise<Partial<Template>> => {
  const model = AVAILABLE_MODELS.GEMINI_3_FLASH;
  
  const prompt = `
    Create a contract review template for a "${contractType}".
    Context: ${context || 'None'}
    Depth: ${depth}. Verbosity: ${verbosity}.
    Return a JSON object with: systemPrompt, formatPrompt, riskTolerance, and clauses array.
    Clauses must have: title, prompt, riskCriteria.
  `;

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      systemPrompt: { type: Type.STRING },
      formatPrompt: { type: Type.STRING },
      riskTolerance: { type: Type.STRING },
      clauses: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            prompt: { type: Type.STRING },
            riskCriteria: { type: Type.STRING }
          },
          required: ["title", "prompt"]
        }
      }
    },
    required: ["systemPrompt", "clauses"]
  };

  const text = await generateUniversalContent({
      model,
      prompt,
      responseSchema: schema
  });

  if (text) return JSON.parse(text);
  throw new Error("Empty response from AI");
};

export const analyzeContract = async (
  template: Template,
  documents: DocumentFile[],
  selectedModel: string = AVAILABLE_MODELS.GEMINI_3_FLASH,
  isRedacted: boolean = false
): Promise<Record<string, any>> => {
  let fullText = documents.map(d => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join("\n\n");
  
  if (isRedacted) {
    fullText = fullText.replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g, "[REDACTED_EMAIL]");
    fullText = fullText.replace(/(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?/g, "[REDACTED_PHONE]");
  }

  const findingProperties: Record<string, Schema> = {};
  template.clauses.forEach(clause => {
    findingProperties[clause.title] = {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        citations: { type: Type.ARRAY, items: { type: Type.STRING } },
        risk_level: { type: Type.STRING, enum: ["High", "Medium", "Low", "Info"] },
        risk_analysis: { type: Type.STRING }
      },
      required: ["summary", "citations", "risk_level"]
    };
  });

  const schema: Schema = {
    type: Type.OBJECT,
    properties: findingProperties,
    required: Object.keys(findingProperties)
  };

  const isRisk = template.mode === 'risk';
  const clauseInstructions = template.clauses.map(c => 
    `- ${c.title}: ${c.prompt} ${isRisk ? `(Risk Criteria: ${c.riskCriteria || template.riskTolerance})` : ''}`
  ).join("\n");

  const prompt = `
    Analyze the following contract text based on these instructions.
    SYSTEM ROLE: ${template.systemPrompt}
    FORMAT RULES: ${template.formatPrompt}
    CLAUSE INSTRUCTIONS:
    ${clauseInstructions}
    DOCUMENT TEXT:
    ${fullText.substring(0, 1000000)}
  `;

  const text = await generateUniversalContent({
      model: selectedModel,
      prompt,
      responseSchema: schema,
      thinkingBudget: selectedModel.includes('pro') || selectedModel.includes('claude-3-7') ? 24000 : undefined
  });

  if (text) return JSON.parse(text);
  throw new Error("No analysis generated");
};

export const chatWithDoc = async (history: string, query: string, context: string): Promise<string> => {
  const model = AVAILABLE_MODELS.GEMINI_3_FLASH;
  const prompt = `
    CONTEXT: ${context.substring(0, 50000)}
    CHAT HISTORY: ${history}
    USER QUERY: ${query}
    Answer as a legal assistant. Be concise.
  `;
  const text = await generateUniversalContent({ model, prompt });
  return text || "I could not generate a response.";
};

export const draftEmail = async (analysisJson: any): Promise<string> => {
    const model = AVAILABLE_MODELS.GEMINI_3_FLASH;
    const prompt = `Draft a professional email summary of these findings: ${JSON.stringify(analysisJson)}`;
    const text = await generateUniversalContent({ model, prompt });
    return text || "Could not draft email.";
};

export const suggestRevision = async (clause: string, original: string, issue: string): Promise<string> => {
    const model = AVAILABLE_MODELS.CLAUDE_3_7_SONNET;
    const prompt = `Mitigate risk for this clause. Clause: ${clause}\nOriginal: ${original}\nIssue: ${issue}`;
    const text = await generateUniversalContent({ model, prompt });
    return text || "Could not generate revision.";
};

export const extractTabularData = async (docContent: string, query: string): Promise<any> => {
    const model = AVAILABLE_MODELS.GEMINI_3_FLASH;
    const prompt = `Document: ${docContent.substring(0, 30000)}\nQuery: "${query}"\nExtract JSON: {value, quote, confidence: 'High'|'Medium'|'Low'}`;
    const text = await generateUniversalContent({
        model,
        prompt,
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                value: { type: Type.STRING },
                quote: { type: Type.STRING },
                confidence: { type: Type.STRING, enum: ['High', 'Medium', 'Low'] }
            },
            required: ["value", "quote", "confidence"]
        }
    });
    return JSON.parse(text!);
};

export const analyzeTable = async (data: TabularData, columns: TabularColumn[], query: string): Promise<string> => {
    const model = AVAILABLE_MODELS.CLAUDE_3_7_SONNET;
    const prompt = `Strategic assessment for table: ${JSON.stringify(data)}\nQuery: ${query}`;
    const text = await generateUniversalContent({ model, prompt, thinkingBudget: 15000 });
    return text || "Could not analyze table.";
};
