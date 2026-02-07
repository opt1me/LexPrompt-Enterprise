
import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Clause, Template, DocumentFile, TabularData, TabularColumn } from "../types";

const apiKey = process.env.API_KEY || ''; // Strict environment variable usage
const ai = new GoogleGenAI({ apiKey });

// Helper to sanitize text
const sanitize = (text: string) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();

export const generateTemplate = async (
  contractType: string,
  depth: 'Light-Touch' | 'Standard' | 'Detailed',
  verbosity: 'Concise' | 'Standard' | 'Lengthy',
  context?: string
): Promise<Partial<Template>> => {
  const model = "gemini-2.5-flash";
  
  const prompt = `
    Create a contract review template for a "${contractType}".
    Context: ${context || 'None'}
    Depth: ${depth}. Verbosity: ${verbosity}.
    
    Return a JSON object with: systemPrompt, formatPrompt, riskTolerance, and clauses array.
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

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    });

    if (response.text) {
      return JSON.parse(response.text);
    }
    throw new Error("Empty response from AI");
  } catch (error) {
    console.error("AI Template Gen Error:", error);
    throw error;
  }
};

export const analyzeContract = async (
  template: Template,
  documents: DocumentFile[],
  isRedacted: boolean = false
): Promise<Record<string, any>> => {
  const model = "gemini-2.5-flash";
  
  // Prepare Context
  let fullText = documents.map(d => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join("\n\n");
  
  if (isRedacted) {
    fullText = fullText.replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g, "[REDACTED_EMAIL]");
    fullText = fullText.replace(/(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?/g, "[REDACTED_PHONE]");
  }

  // Build Schema dynamically based on clauses
  const findingProperties: Record<string, Schema> = {};
  
  template.clauses.forEach(clause => {
    // Normalize key
    const key = clause.title;
    
    findingProperties[key] = {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING, description: "Analysis of the finding" },
        citations: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Verbatim quotes from text" },
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
    ${isRisk ? `GLOBAL RISK TOLERANCE: ${template.riskTolerance}` : ''}
    
    CLAUSE INSTRUCTIONS:
    ${clauseInstructions}
    
    DOCUMENT TEXT:
    ${fullText.substring(0, 500000)} 
  `;

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.1 // Low temperature for factual extraction
      }
    });

    if (response.text) {
      return JSON.parse(response.text);
    }
    throw new Error("No analysis generated");
  } catch (error) {
    console.error("Analysis Error:", error);
    throw error;
  }
};

export const chatWithDoc = async (history: string, query: string, context: string): Promise<string> => {
  const model = "gemini-2.5-flash";
  const prompt = `
    CONTEXT:
    ${context.substring(0, 50000)}
    
    CHAT HISTORY:
    ${history}
    
    USER QUERY:
    ${query}
    
    Answer as a legal assistant. Be concise.
  `;
  
  const response = await ai.models.generateContent({
    model,
    contents: prompt
  });
  
  return response.text || "I could not generate a response.";
};

export const draftEmail = async (analysisJson: any): Promise<string> => {
    const model = "gemini-2.5-flash";
    const prompt = `
        Act as a professional legal consultant. 
        Draft a concise email to the client attached to this contract review. 
        Summarize the key findings and risk levels based on the following analysis data:
        ${JSON.stringify(analysisJson)}
        
        Keep it professional, clear, and highlight the high-risk items first.
    `;
    const response = await ai.models.generateContent({
        model,
        contents: prompt
    });
    return response.text || "Could not draft email.";
};

export const suggestRevision = async (clause: string, original: string, issue: string): Promise<string> => {
    const model = "gemini-2.5-flash";
    const prompt = `
        Clause: ${clause}
        Original Text: "${original}"
        Risk Issue: ${issue}
        
        Task: Rewrite this clause to mitigate the risk while maintaining commercial viability. Return ONLY the rewritten text.
    `;
    const response = await ai.models.generateContent({
        model,
        contents: prompt
    });
    return response.text || "Could not generate revision.";
};

// --- Tabular Review Functions ---

export const extractTabularData = async (
    docContent: string, 
    query: string
): Promise<{ value: string; quote: string; confidence: 'High'|'Medium'|'Low' }> => {
    const model = "gemini-2.5-flash";
    
    const prompt = `
        Document Text:
        ${docContent.substring(0, 30000)}... (truncated)

        Extraction Query: "${query}"

        Instructions:
        1. Answer the query based strictly on the text.
        2. Provide the verbatim substring (quote) from the text that supports your answer.
        3. If not found, set value to "Not Found" and confidence to "High".
        4. Be concise.
    `;

    const schema: Schema = {
        type: Type.OBJECT,
        properties: {
            value: { type: Type.STRING, description: "The extracted answer" },
            quote: { type: Type.STRING, description: "Verbatim text evidence" },
            confidence: { type: Type.STRING, enum: ['High', 'Medium', 'Low'] }
        },
        required: ["value", "quote", "confidence"]
    };

    try {
        const response = await ai.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseMimeType: "application/json",
                responseSchema: schema,
                temperature: 0
            }
        });
        
        // @ts-ignore
        return JSON.parse(response.text);
    } catch (e) {
        console.error("Tabular Extraction Error", e);
        return { value: "Error", quote: "", confidence: "Low" };
    }
};

export const analyzeTable = async (data: TabularData, columns: TabularColumn[], query: string): Promise<string> => {
    const model = "gemini-2.5-flash";
    
    // Convert table data to a simplified JSON for the LLM
    const tableSummary = Object.keys(data).map(docId => {
        const rowData: Record<string, string> = { DocumentID: docId };
        columns.forEach(col => {
            rowData[col.title] = data[docId]?.[col.id]?.value || "N/A";
        });
        return rowData;
    });

    const prompt = `
        You are an expert legal analyst reviewing a summary table of contracts.
        
        Table Data:
        ${JSON.stringify(tableSummary, null, 2)}
        
        User Query: "${query}"
        
        Provide a professional insight or summary based on the table data.
    `;

    const response = await ai.models.generateContent({
        model,
        contents: prompt
    });

    return response.text || "Could not analyze table.";
};
