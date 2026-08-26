
import Anthropic from "@anthropic-ai/sdk";
import { AIProvider, AIModel, GenerationOptions } from "../types";

export class ClaudeProvider implements AIProvider {
    id = 'claude';
    name = 'Anthropic Claude';
    private client: Anthropic | null = null;
    private apiKey: string;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        if (apiKey) {
            this.client = new Anthropic({
                apiKey,
                dangerouslyAllowBrowser: true
            });
        }
    }

    getModels(): AIModel[] {
        return [
            { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'claude' },
            { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'claude' },
            { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'claude' }
        ];
    }

    async generate(prompt: string, options?: GenerationOptions): Promise<string> {
        if (!this.client) throw new Error("Claude API Key missing.");

        const messages: any[] = [];

        // Claude handles system prompt separately in the create call, usually.

        let content: any = prompt;
        if (options?.multimodalImages && options.multimodalImages.length > 0) {
            content = [
                ...options.multimodalImages.map(img => ({
                    type: "image",
                    source: {
                        type: "base64",
                        media_type: img.mime,
                        data: img.data
                    }
                })),
                { type: "text", text: prompt }
            ];
        }
        messages.push({ role: 'user', content });

        const msg = await this.client.messages.create({
            model: options?.modelId || "claude-opus-4-6",
            max_tokens: 4096, // Increased thinking budget might need more?
            temperature: options?.temperature ?? 0.7,
            system: options?.systemPrompt,
            messages: messages,
            // @ts-ignore - SDK might not have 2026 types yet
            thinking: {
                type: "adaptive"
            },
            // @ts-ignore
            effort: "high"
        });

        const textBlock = msg.content[0];
        if (textBlock.type === 'text') {
            return textBlock.text;
        }
        return "";
    }
}
