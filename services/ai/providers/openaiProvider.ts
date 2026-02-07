
import OpenAI from "openai";
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
            { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai' }
        ];
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
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
        messages.push({ role: 'user', content });

        const completion = await this.client.chat.completions.create({
            model: "gpt-5.2", // Default Flagship
            messages: messages,
            temperature: options?.temperature ?? 0.7,
            response_format: options?.jsonSchema ? {
                type: "json_schema",
                json_schema: {
                    name: "output_schema",
                    schema: options.jsonSchema,
                    strict: true
                }
            } : undefined
        });

        const text = completion.choices[0].message.content;
        if (!text) throw new Error("Empty response from OpenAI");
        return text;
    }
}
