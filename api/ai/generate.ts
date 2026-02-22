import { GoogleGenAI } from "@google/genai";
import { getActorContext, requireWorkspaceMember } from "../_lib/auth";
import { pushActivity } from "../_lib/collabStore";
import { enforceRateLimit } from "../_lib/rateLimit";

const ALLOWED_REGIONS = ["uk-london", "eu-frankfurt", "eu-ireland"] as const;
const ALLOWED_MODELS = new Set([
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gpt-5-nano",
  "gpt-5-mini",
  "gpt-5",
  "claude-haiku-4-5",
  "claude-sonnet-4-5",
]);
const MAX_PROMPT_CHARS = 120_000;
const MAX_SYSTEM_CHARS = 30_000;
const MAX_SCHEMA_CHARS = 25_000;
const MAX_OUTPUT_TOKENS = 4_096;

type Provider = "google" | "openai" | "anthropic";

interface RequestBody {
  workspaceId: string;
  model: string;
  system?: string;
  prompt: string;
  responseSchema?: any;
  temperature?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  compliance: {
    region: (typeof ALLOWED_REGIONS)[number];
    residencyMode: "uk_preferred_eu_fallback" | "strict_uk_only" | "eu_only";
    noTraining: boolean;
    minRetention: boolean;
    policyVersion: string;
  };
}

const asJson = (value: unknown) => JSON.stringify(value);

const getProvider = (model: string): Provider => {
  if (model.includes("gemini")) return "google";
  if (model.includes("gpt") || model.startsWith("o")) return "openai";
  if (model.includes("claude")) return "anthropic";
  return "google";
};

const getEnvApiKey = (provider: Provider): string | undefined => {
  if (provider === "google") return process.env.GEMINI_API_KEY || process.env.API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  return process.env.ANTHROPIC_API_KEY;
};

const sanitizeApiKey = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  const key = String(raw).trim();
  if (!key || key.toLowerCase() === "undefined" || key.toLowerCase() === "null") return undefined;
  return key;
};

const typeToJsonSchema = (value: any): any => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(typeToJsonSchema);
  const next: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "type" && typeof v === "string") {
      next[k] = v.toLowerCase();
    } else {
      next[k] = typeToJsonSchema(v);
    }
  }
  if (next.type === "object") {
    if (next.additionalProperties === undefined) {
      next.additionalProperties = false;
    }
    if (next.properties && typeof next.properties === "object" && !Array.isArray(next.properties)) {
      next.required = Object.keys(next.properties);
    }
  }
  return next;
};

const validateRegion = (body: RequestBody): string | null => {
  if (!ALLOWED_REGIONS.includes(body.compliance.region)) return "Region is not allowed by policy.";
  if (body.compliance.residencyMode === "strict_uk_only" && body.compliance.region !== "uk-london") {
    return "Strict UK policy requires uk-london.";
  }
  return null;
};

const validatePayload = (body: RequestBody): string | null => {
  if (!body.workspaceId || typeof body.workspaceId !== "string") return "workspaceId is required";
  if (!body.model || typeof body.model !== "string") return "model is required";
  if (!ALLOWED_MODELS.has(body.model)) return "Model is not allowed";
  if (typeof body.prompt !== "string" || body.prompt.length === 0) return "prompt is required";
  if (body.prompt.length > MAX_PROMPT_CHARS) return `prompt exceeds ${MAX_PROMPT_CHARS} characters`;
  if (body.system && String(body.system).length > MAX_SYSTEM_CHARS) return `system exceeds ${MAX_SYSTEM_CHARS} characters`;
  if (!body.compliance || typeof body.compliance !== "object") return "compliance is required";
  if (body.responseSchema) {
    const schemaChars = asJson(body.responseSchema).length;
    if (schemaChars > MAX_SCHEMA_CHARS) return `responseSchema exceeds ${MAX_SCHEMA_CHARS} characters`;
  }
  if (typeof body.maxOutputTokens === "number" && body.maxOutputTokens > MAX_OUTPUT_TOKENS) {
    return `maxOutputTokens must be <= ${MAX_OUTPUT_TOKENS}`;
  }
  return null;
};

const callGoogle = async (apiKey: string, body: RequestBody): Promise<string> => {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: body.model,
    contents: body.prompt,
    config: {
      systemInstruction: body.system,
      responseMimeType: body.responseSchema ? "application/json" : "text/plain",
      responseSchema: body.responseSchema,
      temperature: body.temperature ?? 0.1,
      ...(body.maxOutputTokens ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(body.thinkingBudget ? { thinkingConfig: { thinkingBudget: body.thinkingBudget } } : {}),
    },
  });
  return response.text || "";
};

const callOpenAI = async (apiKey: string, body: RequestBody): Promise<string> => {
  const isReasoning = body.model.startsWith("o");
  const supportsCustomTemperature = !body.model.startsWith("gpt-5") && !isReasoning;
  const readResponseText = (data: any): string => {
    if (typeof data?.output_text === "string" && data.output_text.length > 0) return data.output_text;
    const output = Array.isArray(data?.output) ? data.output : [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const c of content) {
        if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
        if (c?.type === "text" && typeof c?.text === "string") return c.text;
      }
    }
    return "";
  };

  const basePayload: any = {
    model: body.model,
    input: body.prompt,
    store: false,
    ...(body.system ? { instructions: body.system } : {}),
    ...(supportsCustomTemperature ? { temperature: body.temperature ?? 0.1 } : {}),
    ...(body.maxOutputTokens ? { max_output_tokens: body.maxOutputTokens } : {}),
  };
  const payload: any = {
    ...basePayload,
    ...(body.responseSchema
      ? {
          text: {
            format: {
              type: "json_schema",
              name: "lexprompt_schema",
              schema: typeToJsonSchema(body.responseSchema),
              strict: true,
            },
          },
        }
      : {}),
  };

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "x-lexprompt-region": body.compliance.region,
      "x-lexprompt-policy": body.compliance.policyVersion,
    },
    body: asJson(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data.error?.message || "OpenAI request failed";
    if (body.responseSchema && /json_schema|response_format|text\.format|schema/i.test(message)) {
      const retryPayload: any = {
        ...basePayload,
        text: { format: { type: "json_object" } },
      };
      const retry = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-lexprompt-region": body.compliance.region,
          "x-lexprompt-policy": body.compliance.policyVersion,
        },
        body: asJson(retryPayload),
      });
      const retryData = await retry.json();
      if (retry.ok) return readResponseText(retryData);

      const retryMessage = retryData.error?.message || message;

          const finalPayload: any = {
            model: body.model,
            input: `${body.prompt}\n\nReturn only valid JSON. No markdown, no explanation.`,
            store: false,
            ...(body.system ? { instructions: body.system } : {}),
            ...(supportsCustomTemperature ? { temperature: body.temperature ?? 0.1 } : {}),
            ...(body.maxOutputTokens ? { max_output_tokens: body.maxOutputTokens } : {}),
          };
      const final = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-lexprompt-region": body.compliance.region,
          "x-lexprompt-policy": body.compliance.policyVersion,
        },
        body: asJson(finalPayload),
      });
      const finalData = await final.json();
      if (!final.ok) throw new Error(finalData.error?.message || retryMessage);
      return readResponseText(finalData);
    }
    throw new Error(message);
  }
  return readResponseText(data);
};

const callAnthropic = async (apiKey: string, body: RequestBody): Promise<string> => {
  const payload = {
    model: body.model,
    max_tokens: body.maxOutputTokens ?? 4096,
    system: body.system,
    messages: [{ role: "user", content: body.prompt }],
    temperature: body.temperature ?? 0.1,
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "x-lexprompt-region": body.compliance.region,
      "x-lexprompt-policy": body.compliance.policyVersion,
    },
    body: asJson(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Anthropic request failed");
  return data.content?.[0]?.text || "";
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!enforceRateLimit(req, res, "ai_proxy_ip", { limit: 80, windowMs: 60_000 })) return;

  let actorEmail = "unknown";
  try {
    const actor = await getActorContext(req, res);
    actorEmail = actor.email;
    if (!enforceRateLimit(req, res, "ai_proxy_actor", { limit: 60, windowMs: 60_000, keySuffix: actor.email })) return;

    const body = (req.body || {}) as RequestBody;
    const validationError = validatePayload(body);
    if (validationError) return res.status(400).json({ error: validationError });

    const regionError = validateRegion(body);
    if (regionError) return res.status(400).json({ error: regionError });

    await requireWorkspaceMember(body.workspaceId, actor.email);

    const provider = getProvider(body.model);
    const apiKey = sanitizeApiKey(getEnvApiKey(provider));
    if (!apiKey) return res.status(500).json({ error: `Missing server API key for ${provider}` });

    const text =
      provider === "google"
        ? await callGoogle(apiKey, body)
        : provider === "openai"
        ? await callOpenAI(apiKey, body)
        : await callAnthropic(apiKey, body);

    await pushActivity(body.workspaceId, actor.email, "ai_generate", `ai:${provider}:${body.model}`, {
      workspaceId: body.workspaceId,
      provider,
      model: body.model,
      region: body.compliance.region,
      policyVersion: body.compliance.policyVersion,
    });

    return res.status(200).json({
      text,
      provider,
      model: body.model,
      region: body.compliance.region,
      policyVersion: body.compliance.policyVersion,
    });
  } catch (error: any) {
    const workspaceId = String(req?.body?.workspaceId || "").trim();
    if (workspaceId) {
      try {
        await pushActivity(workspaceId, actorEmail || "unknown", "ai_generate_failed", `ai:error`, {
          message: error?.message || "Server AI proxy failure",
        });
      } catch {
        // Ignore audit logging failures.
      }
    }
    return res.status(error?.status || 500).json({ error: error.message || "Server AI proxy failure" });
  }
}
