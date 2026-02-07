
import { GoogleGenAI, Schema, Type } from "@google/genai";
import { AIProvider, AIModel, GenerationOptions } from "../types";

export class GeminiProvider implements AIProvider {
    id = 'gemini';
    name = 'Google Gemini';
    private client: GoogleGenAI | null = null;
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            this.client = new GoogleGenAI({ apiKey });
        }
    }

    getModels(): AIModel[] {
        return [
            { id: 'gemini-3.0-flash', name: 'Gemini 3 Flash', provider: 'gemini' },
            { id: 'gemini-3.0-pro', name: 'Gemini 3 Pro', provider: 'gemini' }
        ];
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (!this.client) throw new Error("Gemini API Key missing.");

        const modelName = "gemini-3.0-pro"; // Default to the powerful one
        // Ideally options should include modelId, but for now we hardcode or add to options.
        // Let's stick to a safe default or allow overriding if I update interface later.

        // Convert generic Schema to Gemini Schema if needed
        // The generic schema passed from service might need adaptation, 
        // but for now let's assume it's compatible or we just pass it if it's JSON schema.
        // Google GenAI SDK accepts standard JSON schema in strict mode, mostly.

        const config: any = {
            temperature: options?.temperature ?? 0.7,
        };

        if (options?.jsonSchema) {
            config.responseMimeType = "application/json";
            config.responseSchema = options.jsonSchema;
        }

        // Prepare contents
        let contents: any[] = [];
        if (options?.systemPrompt) {
            // Gemini supports systemInstruction at model init or request.
            // But here we might just prepend it to prompt if we want simple stateless
            // OR use the systemInstruction property.
        }

        // Actually, newer Gemini SDK supports systemInstruction in generateContent config?
        // No, it's usually in model instantiation.
        // To support per-request system prompt efficiently without re-instantiating model,
        // prepending to prompt is safest for now, OR using `systemInstruction` if SDK allows in call.
        // Checking SDK... usually `getGenerativeModel({ model: ..., systemInstruction: ... })`.

        const model = this.client.models;

        // Construct request
        let userPrompt = prompt;
        if (options?.systemPrompt) {
            // Simple prepend approach for broad compatibility
            userPrompt = `SYSTEM INSTRUCTION: ${options.systemPrompt}\n\n${prompt}`;
        }

        contents.push(userPrompt);

        if (options?.multimodalImages) {
            options.multimodalImages.forEach(img => {
                contents.push({
                    inlineData: {
                        mimeType: img.mime,
                        data: img.data
                    }
                });
            });
        }

        try {
            const result = await model.generateContent({
                model: modelName,
                contents,
                config
            });
            return result.text || "";
        } catch (e) {
            console.error("Gemini Generate Error:", e);
            throw e;
        }
    }
}
