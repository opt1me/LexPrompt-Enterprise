
export interface AIModel {
    id: string;
    name: string;
    provider: 'gemini' | 'openai' | 'claude';
}

export interface GenerationOptions {
    systemPrompt?: string;
    jsonSchema?: any;
    temperature?: number;
    multimodalImages?: { mime: string; data: string }[]; // Base64
}

export interface AIProvider {
    id: string;
    name: string;
    getModels(): AIModel[];
    generate(prompt: string, options?: GenerationOptions): Promise<string>;
}
