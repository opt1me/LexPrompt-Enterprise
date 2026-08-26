
import OpenAI from "openai";
import fs from 'fs';
import { AIProvider, AIModel, GenerationOptions } from "../types";

export class OpenAIProvider implements AIProvider {
    id = 'openai';
    name = 'OpenAI';
    private client: OpenAI | null = null;
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            this.client = new OpenAI({
                apiKey,
                dangerouslyAllowBrowser: true // Required for client-side usage
            });
        }
    }

    getModels(): AIModel[] {
        return [
            { id: 'gpt-5.2', name: 'GPT-5.2 (Reasoning)', provider: 'openai' },
            { id: 'gpt-5', name: 'GPT-5 Flagship', provider: 'openai' },
            { id: 'gpt-5-mini', name: 'GPT-5 Mini', provider: 'openai' }
        ];
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (process.env.DEBUG_AI === 'true') {
            fs.writeSync(1, `\n--- OPENAI RESPONSES START --- [${new Date().toLocaleTimeString()}]\n`);
        }
        if (!this.client) throw new Error("OpenAI API Key missing.");

        const messages: any[] = [];
        if (options?.systemPrompt) {
            messages.push({ role: 'system', content: options.systemPrompt });
        }

        let content: any = prompt;
        if (options?.multimodalImages && options.multimodalImages.length > 0) {
            // OpenAI only supports specific image types
            const validImages = options.multimodalImages.filter(img =>
                ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(img.mime)
            );

            if (validImages.length > 0) {
                content = [
                    { type: "text", text: prompt },
                    ...validImages.map(img => ({
                        type: "image_url",
                        image_url: {
                            url: `data:${img.mime};base64,${img.data}`
                        }
                    }))
                ];
            }
        }
        if (options?.multimodalFiles && options.multimodalFiles.length > 0) {
            if (!Array.isArray(content)) {
                content = [{ type: "text", text: prompt }];
            }
            content.push(...options.multimodalFiles.map(file => ({
                type: "file_url",
                file_url: {
                    url: `data:${file.mime};base64,${file.data}`
                }
            })));
        }

        const modelId = options?.modelId || "gpt-5.2";

        if (process.env.DEBUG_AI === 'true') {
            fs.writeSync(1, `[${new Date().toLocaleTimeString()}] 🚀 AI SEND | Model: ${modelId}\n`);
            fs.writeSync(1, `   [PROMPT] ${prompt.substring(0, 200)}...\n`);
            if (modelId.includes('5.2')) {
                fs.writeSync(1, `   [NOTE] This is a reasoning model. It may take 30-90s to "think" before responding.\n`);
            }
        }

        const isReasoningModel = modelId.startsWith('gpt-5');
        const isStreaming = !!options?.onStream && !options?.jsonSchema;

        // Structured Output Config
        const textFormat = options?.jsonSchema ? {
            type: "json_schema",
            name: "output_schema",
            schema: options.jsonSchema,
            strict: true
        } : undefined;

        if (isStreaming) {
            const stream = await (this.client as any).responses.create({
                model: modelId,
                instructions: options?.systemPrompt || "You are a helpful assistant.",
                input: content,
                stream: true,
                ...(!isReasoningModel ? { temperature: options?.temperature ?? 0.7 } : {}),
            });

            let fullText = "";
            for await (const part of stream) {
                // The Responses API stream format differs slightly from Chat Completions
                const delta = part.delta?.text || "";
                fullText += delta;
                if (delta) options?.onStream?.(delta);
            }

            if (process.env.DEBUG_AI === 'true') {
                fs.writeSync(1, `[${new Date().toLocaleTimeString()}] ✅ AI STREAM DONE | Len: ${fullText.length} chars\n\n`);
            }
            return fullText;
        }

        const response = await (this.client as any).responses.create({
            model: modelId,
            instructions: options?.systemPrompt || "You are a helpful assistant.",
            input: content,
            ...(!isReasoningModel ? { temperature: options?.temperature ?? 0.7 } : {}),
            text: textFormat ? { format: textFormat } : undefined
        });

        const text = response.output_text;
        if (!text) throw new Error("Empty response from OpenAI Responses API");

        if (process.env.DEBUG_AI === 'true') {
            fs.writeSync(1, `[${new Date().toLocaleTimeString()}] ✅ AI RECV | Len: ${text.length} chars\n`);
            fs.writeSync(1, `   [PREVIEW] ${text.substring(0, 200)}...\n\n`);
        }

        return text;
    }
}
