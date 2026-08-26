
export interface AIModel {
    id: string;
    name: string;
    provider: 'gemini' | 'openai' | 'claude';
}

export interface GenerationOptions {
    systemPrompt?: string;
    jsonSchema?: any;
    temperature?: number;
    modelId?: string;
    multimodalImages?: { mime: string; data: string }[]; // Base64
    multimodalFiles?: { mime: string; data: string; name: string }[]; // New: For PDFs, etc.
    onStream?: (chunk: string) => void; // New: For real-time UI updates
}

export interface AIProvider {
    id: string;
    name: string;
    getModels(): AIModel[];
    generate(prompt: string, options?: GenerationOptions): Promise<string>;
}
