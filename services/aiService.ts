import { GoogleGenAI, Type, Schema } from "@google/genai";
import { Clause, Template, DocumentFile, TabularData, TabularColumn, AIProvider, DataRegion, ResidencySettings } from "../types";

export const AVAILABLE_MODELS = {
  // Google Gemini (efficient 2.5 family)
  GEMINI_2_5_FLASH_LITE: "gemini-2.5-flash-lite",
  GEMINI_2_5_FLASH: "gemini-2.5-flash",
  GEMINI_2_5_PRO: "gemini-2.5-pro",

  // OpenAI GPT-5 family
  GPT_5_NANO: "gpt-5-nano",
  GPT_5_MINI: "gpt-5-mini",
  GPT_5: "gpt-5",

  // Anthropic Claude 4.5 family
  CLAUDE_HAIKU_4_5: "claude-haiku-4-5",
  CLAUDE_SONNET_4_5: "claude-sonnet-4-5",
};

export interface ComplianceContext {
  region: DataRegion;
  residencyMode: ResidencySettings["residencyMode"];
  noTraining: boolean;
  minRetention: boolean;
  policyVersion: string;
}

export interface AnalysisExecutionMeta {
  provider: AIProvider;
  model: string;
  region: DataRegion;
  policyVersion: string;
}

export type ClauseProgressStatus = "queued" | "running" | "done" | "error";
export type ClauseProgressCallback = (clauseTitle: string, status: ClauseProgressStatus, detail?: string) => void;

interface UniversalParams {
  model: string;
  system?: string;
  prompt: string;
  responseSchema?: any;
  temperature?: number;
  thinkingBudget?: number;
  maxOutputTokens?: number;
  compliance: ComplianceContext;
}

type KeyPolicy = "platform" | "byok" | "hybrid";

type AnyObj = Record<string, any>;
const CLAUSE_ANALYSIS_CONCURRENCY = 4;
const MAX_CLAUSE_CONTEXT_CHARS = 18000;
const MAX_SEGMENT_CHARS = 900;
const MAX_SEGMENTS_PER_CLAUSE = 10;
const MAX_RISK_ANALYSIS_CHARS = 320;
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "are", "was", "were", "will", "shall", "into",
  "about", "have", "has", "had", "your", "their", "they", "them", "there", "here", "under", "over",
  "between", "where", "when", "which", "what", "whose", "being", "been", "than", "then", "such", "only",
  "must", "may", "can", "not", "but", "any", "all", "our", "you", "his", "her", "its", "also", "per",
  "each", "within", "without", "onto", "upon", "into", "out", "off", "via", "very", "more", "less",
  "agreement", "contract", "clause", "section", "article", "party", "parties", "tenant", "landlord",
]);

const getProviderForModel = (model: string): AIProvider => {
  if (model.includes("gemini")) return "google";
  if (model.includes("gpt") || model.startsWith("o")) return "openai";
  if (model.includes("claude")) return "anthropic";
  return "google";
};

export { getProviderForModel };

const getKeyPolicy = (): KeyPolicy => {
  const raw = String((import.meta as any).env?.VITE_KEY_POLICY ?? "hybrid").toLowerCase().trim();
  if (raw === "platform" || raw === "byok" || raw === "hybrid") return raw;
  return "hybrid";
};

const getApiKey = (provider: AIProvider): string | undefined => {
  const savedKeys = localStorage.getItem("lexprompt_api_keys");
  if (savedKeys) {
    const keys = JSON.parse(savedKeys);
    if (keys[provider]) return keys[provider];
  }
  if (getKeyPolicy() === "byok") return undefined;
  if (provider === "google") return process.env.API_KEY || process.env.GEMINI_API_KEY;
  if (provider === "openai") return process.env.OPENAI_API_KEY;
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY;
  return undefined;
};

const sanitizeApiKey = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  const key = String(raw).trim();
  if (!key || key.toLowerCase() === "undefined" || key.toLowerCase() === "null") return undefined;
  return key;
};

const pickBestAvailableModel = (candidates: string[]): string => {
  if (getKeyPolicy() === "platform") return candidates[0];
  for (const model of candidates) {
    const provider = getProviderForModel(model);
    if (getApiKey(provider)) return model;
  }
  return candidates[0];
};

const typeToJsonSchema = (value: any): any => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(typeToJsonSchema);

  const next: AnyObj = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "type" && typeof v === "string") {
      const lower = v.toLowerCase();
      next[k] = lower;
      continue;
    }
    next[k] = typeToJsonSchema(v);
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

const normalizeRiskLevel = (value: any): "High" | "Medium" | "Low" | "Info" => {
  const v = String(value || "").toLowerCase();
  if (v === "high") return "High";
  if (v === "medium") return "Medium";
  if (v === "low") return "Low";
  return "Info";
};

const strictNormalize = (value: string): string => value.replace(/[^a-z0-9]/gi, "").toLowerCase();

const pickLongest = (values: string[]): string | null => {
  if (values.length === 0) return null;
  return values.sort((a, b) => b.length - a.length)[0];
};

const stripKnownCitationPrefixes = (value: string): string => {
  let next = value.trim();
  let changed = true;

  while (changed) {
    const before = next;
    next = next
      .replace(/^(?:document|doc)\s*:\s*/i, "")
      .replace(/^page\s*\d+\s*[:\-]?\s*/i, "")
      .replace(/^\[?\s*page\s*\d+\s*\]?\s*[:\-]?\s*/i, "")
      .replace(/^(?:clause|section|article)\s*[a-z0-9().-]+\s*[:\-]\s*/i, "")
      .replace(/^verbatim\s*(?:ref(?:erence)?)?\s*\d*\s*[:\-]\s*/i, "")
      .trim();
    changed = next !== before;
  }

  return next;
};

const extractQuotedSpan = (value: string): string => {
  const normalized = value.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const wrapped = normalized.match(/^["']([\s\S]+)["']$/);
  if (wrapped?.[1]) return wrapped[1].trim();

  const doubleQuoted = Array.from(normalized.matchAll(/"([^"]{6,})"/g)).map((m) => m[1].trim());
  const singleQuoted = Array.from(normalized.matchAll(/(?:^|[\s([{])'([^']{6,})'(?:$|[\s)\]}.,;:])/g)).map((m) => m[1].trim());
  const picked = pickLongest([...doubleQuoted, ...singleQuoted]);
  return picked || normalized;
};

const sanitizeCitation = (value: string): string => {
  let next = String(value || "").trim();
  if (!next) return "";

  next = extractQuotedSpan(next);
  next = stripKnownCitationPrefixes(next);
  next = next
    .replace(/^[\s"'`()[\]{}<>:;,.!?*\-|\/\u2022\u25CF]+/, "")
    .replace(/[\s"'`()[\]{}<>:;,.!?*\-|\/\u2022\u25CF]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  next = stripKnownCitationPrefixes(next);
  next = next
    .replace(/^[\s"'`()[\]{}<>:;,.!?*\-|\/\u2022\u25CF]+/, "")
    .replace(/[\s"'`()[\]{}<>:;,.!?*\-|\/\u2022\u25CF]+$/, "")
    .replace(/\s+/g, " ")
    .trim();

  return next;
};

const sanitizeCitations = (value: any): string[] => {
  if (!Array.isArray(value)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const cleaned = sanitizeCitation(entry);
    if (cleaned.length < 8) continue;
    const normalizedKey = strictNormalize(cleaned);
    if (!normalizedKey) continue;
    if (seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    out.push(cleaned);
  }
  return out;
};

const parseJsonSafe = (raw: string): any => {
  const cleaned = String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/```json\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  if (!cleaned) {
    throw new Error("AI returned invalid JSON");
  }

  const tryParse = (value: string): any | null => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const direct = tryParse(cleaned);
  if (direct !== null) return direct;

  const firstObj = cleaned.indexOf("{");
  const lastObj = cleaned.lastIndexOf("}");
  if (firstObj !== -1 && lastObj > firstObj) {
    const objCandidate = cleaned.slice(firstObj, lastObj + 1);
    const parsedObj = tryParse(objCandidate);
    if (parsedObj !== null) return parsedObj;

    const repairedObj = objCandidate
      .replace(/,\s*([}\]])/g, "$1")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");
    const parsedRepairedObj = tryParse(repairedObj);
    if (parsedRepairedObj !== null) return parsedRepairedObj;
  }

  const firstArr = cleaned.indexOf("[");
  const lastArr = cleaned.lastIndexOf("]");
  if (firstArr !== -1 && lastArr > firstArr) {
    const arrCandidate = cleaned.slice(firstArr, lastArr + 1);
    const parsedArr = tryParse(arrCandidate);
    if (parsedArr !== null) return parsedArr;
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");
    if (first === -1 || last <= first) {
      throw new Error("AI returned invalid JSON");
    }
    return JSON.parse(cleaned.slice(first, last + 1));
  }
};

const tokenize = (value: string): string[] =>
  String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

const splitSegmentBySentences = (text: string): string[] => {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length === 0) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length <= MAX_SEGMENT_CHARS) {
      current = next;
      continue;
    }
    if (current) chunks.push(current);
    if (sentence.length <= MAX_SEGMENT_CHARS) {
      current = sentence;
      continue;
    }
    for (let i = 0; i < sentence.length; i += MAX_SEGMENT_CHARS) {
      chunks.push(sentence.slice(i, i + MAX_SEGMENT_CHARS).trim());
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
};

const splitIntoSegments = (text: string): string[] => {
  const normalized = String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\[page\s+\d+\]\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return [];

  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .filter((block) => block.length > 40);

  const segments: string[] = [];
  for (const block of blocks) {
    if (block.length <= MAX_SEGMENT_CHARS) {
      segments.push(block);
      continue;
    }
    splitSegmentBySentences(block).forEach((chunk) => {
      if (chunk.length > 25) segments.push(chunk);
    });
  }
  return segments;
};

const scoreSegment = (segment: string, queryTokenSet: Set<string>): number => {
  if (!segment || queryTokenSet.size === 0) return 0;
  const segmentTokens = new Set(tokenize(segment));
  let score = 0;
  for (const token of queryTokenSet) {
    if (!segmentTokens.has(token)) continue;
    score += token.length >= 8 ? 2 : 1;
  }
  return score;
};

const selectClauseContext = (segments: string[], clause: Clause, template: Template, fallbackContext: string): string => {
  if (!segments.length) return fallbackContext.slice(0, MAX_CLAUSE_CONTEXT_CHARS);

  const query = `${clause.title} ${clause.prompt} ${clause.riskCriteria || ""} ${template.riskTolerance || ""}`;
  const queryTokens = new Set(tokenize(query));

  const ranked = segments
    .map((segment, idx) => ({ segment, idx, score: scoreSegment(segment, queryTokens) }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const selected: Array<{ segment: string; idx: number; score: number }> = [];
  for (const item of ranked) {
    if (item.score <= 0) break;
    selected.push(item);
    if (selected.length >= MAX_SEGMENTS_PER_CLAUSE) break;
  }

  if (selected.length < 4) {
    for (const item of ranked) {
      if (selected.some((picked) => picked.idx === item.idx)) continue;
      selected.push(item);
      if (selected.length >= 4) break;
    }
  }

  const byDocumentOrder = selected
    .sort((a, b) => a.idx - b.idx)
    .map((item) => item.segment)
    .join("\n\n");

  const trimmed = byDocumentOrder.slice(0, MAX_CLAUSE_CONTEXT_CHARS).trim();
  return trimmed || fallbackContext.slice(0, MAX_CLAUSE_CONTEXT_CHARS);
};

const normalizeRiskAnalysis = (value: any): string => {
  const raw = String(value || "")
    .replace(/[•·]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return "";

  const sentences = raw.split(/(?<=[.!?])\s+/).filter(Boolean);
  const concise = (sentences.slice(0, 2).join(" ") || raw).trim();
  if (concise.length <= MAX_RISK_ANALYSIS_CHARS) return concise;

  const truncated = concise.slice(0, MAX_RISK_ANALYSIS_CHARS);
  const sentenceBoundary = truncated.lastIndexOf(".");
  if (sentenceBoundary > 120) {
    return truncated.slice(0, sentenceBoundary + 1).trim();
  }
  return `${truncated.trimEnd()}...`;
};

const buildFallbackRiskAnalysis = (summary: string, riskLevel: "High" | "Medium" | "Low" | "Info"): string => {
  if (riskLevel === "Info") {
    return "Informational finding with no material risk trigger identified in the extracted text.";
  }

  const conciseSummary = String(summary || "")
    .replace(/\s+/g, " ")
    .trim();
  const shortSummary =
    conciseSummary.length > 200
      ? `${conciseSummary.slice(0, 197).trimEnd()}...`
      : conciseSummary;

  const prefix =
    riskLevel === "High"
      ? "High risk due to clear adverse clause language."
      : riskLevel === "Medium"
      ? "Medium risk due to potentially unfavorable obligations."
      : "Low risk; wording appears generally acceptable but should be confirmed.";
  return normalizeRiskAnalysis(`${prefix} ${shortSummary}`.trim());
};

const noResultFinding = (summary: string, riskAnalysis = "") => ({
  summary,
  citations: [],
  risk_level: "Info" as const,
  risk_analysis: normalizeRiskAnalysis(riskAnalysis),
});

const normalizeFinding = (value: any) => {
  if (!value || typeof value !== "object") {
    return noResultFinding(typeof value === "string" ? value : "No finding generated.");
  }
  const citations = sanitizeCitations(value.citations);
  return {
    summary: String(value.summary || value.value || "No finding generated."),
    citations,
    risk_level: normalizeRiskLevel(value.risk_level),
    risk_analysis: normalizeRiskAnalysis(value.risk_analysis),
  };
};

const normalizeFindingsToTemplate = (template: Template, raw: any): Record<string, any> => {
  const clauseTitles = template.clauses.map((c) => c.title);
  const out: Record<string, any> = {};

  const source: AnyObj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const sourceKeys = Object.keys(source);

  const findClauseKey = (title: string): string | undefined => {
    if (source[title]) return title;
    const normalized = title.replace(/\s+/g, "").toLowerCase();
    return sourceKeys.find((k) => k.replace(/\s+/g, "").toLowerCase() === normalized);
  };

  for (const title of clauseTitles) {
    const key = findClauseKey(title);
    if (key) {
      out[title] = normalizeFinding(source[key]);
    } else {
      out[title] = noResultFinding("No clause-specific result was returned for this prompt.");
    }
  }

  // Attempt salvage from generic arrays if no clauses matched.
  const noMatches = clauseTitles.every((t) => out[t]?.summary?.includes("No clause-specific"));
  const genericItems = Array.isArray(source.findings)
    ? source.findings
    : Array.isArray(raw)
    ? raw
    : [];

  if (noMatches && genericItems.length > 0) {
    clauseTitles.forEach((title, idx) => {
      const item = genericItems[idx];
      if (item) out[title] = normalizeFinding(item);
    });
  }

  return out;
};

const maybeUseServerProxy = async (params: UniversalParams): Promise<string | null> => {
  const keyPolicy = getKeyPolicy();
  if (keyPolicy === "byok") return null;

  const proxyMode = ((import.meta as any).env?.VITE_USE_AI_PROXY ?? "auto").toLowerCase();
  const allowClientFallback = ((import.meta as any).env?.VITE_ALLOW_CLIENT_SIDE_AI ?? "true") === "true";

  // In local Vite dev, API routes are usually unavailable unless a dedicated backend is running.
  if (proxyMode === "false") return null;
  if (
    keyPolicy !== "platform" &&
    proxyMode === "auto" &&
    allowClientFallback &&
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ) {
    return null;
  }

  const endpoint = (import.meta as any).env?.VITE_AI_PROXY_URL || "/api/ai/generate";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || "AI proxy call failed");
    }
    const data = await res.json();
    return data.text || null;
  } catch {
    return null;
  }
};

const generateUniversalContent = async (params: UniversalParams): Promise<string> => {
  const keyPolicy = getKeyPolicy();
  const proxyText = await maybeUseServerProxy(params);
  if (proxyText) return proxyText;

  if (keyPolicy === "platform") {
    throw new Error("Workspace-managed AI mode is enabled, but server AI proxy is unavailable. Contact your administrator.");
  }

  const allowClientFallback = ((import.meta as any).env?.VITE_ALLOW_CLIENT_SIDE_AI ?? "true") === "true";
  if (!allowClientFallback) {
    throw new Error("AI proxy unavailable. Enable server routing or set VITE_ALLOW_CLIENT_SIDE_AI=true for local-only testing.");
  }

  const provider = getProviderForModel(params.model);
  const apiKey = sanitizeApiKey(getApiKey(provider));
  if (!apiKey) {
    throw new Error(
      `Missing or invalid API Key for ${provider.toUpperCase()}. ` +
      `For local testing, set OPENAI_API_KEY in .env.local and restart npm run dev, ` +
      `or add it in Engine Settings (BYOK).`
    );
  }

  if (provider === "google") {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: params.model,
      contents: params.prompt,
      config: {
        systemInstruction: params.system,
        responseMimeType: params.responseSchema ? "application/json" : "text/plain",
        responseSchema: params.responseSchema,
        temperature: params.temperature ?? 0.1,
        ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
        ...(params.thinkingBudget ? { thinkingConfig: { thinkingBudget: params.thinkingBudget } } : {}),
      },
    });
    return response.text || "";
  }

  if (provider === "openai") {
    const isReasoning = params.model.startsWith("o");
    const isGpt5Model = params.model.startsWith("gpt-5");
    const supportsCustomTemperature = !params.model.startsWith("gpt-5") && !isReasoning;

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

    const baseBody: any = {
      model: params.model,
      input: params.prompt,
      ...(params.system ? { instructions: params.system } : {}),
      ...(supportsCustomTemperature ? { temperature: params.temperature ?? 0.1 } : {}),
      ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
      ...(isGpt5Model ? { reasoning: { effort: "low" } } : {}),
    };

    const body: any = {
      ...baseBody,
      ...(params.responseSchema
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "lexprompt_schema",
                schema: typeToJsonSchema(params.responseSchema),
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
        "x-lexprompt-region": params.compliance.region,
        "x-lexprompt-policy": params.compliance.policyVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      const msg = err.error?.message || "OpenAI API Error";

      if (params.responseSchema && /json_schema|response_format|text\.format|schema/i.test(msg)) {
        const retryBody: any = {
          ...baseBody,
          text: { format: { type: "json_object" } },
        };
        const retryRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-lexprompt-region": params.compliance.region,
            "x-lexprompt-policy": params.compliance.policyVersion,
          },
          body: JSON.stringify(retryBody),
        });
        const retryData = await retryRes.json();
        if (retryRes.ok) return readResponseText(retryData);

        const retryMsg = retryData.error?.message || msg;
        const finalBody: any = {
          model: params.model,
          input: `${params.prompt}\n\nReturn only valid JSON. No markdown, no explanation.`,
          ...(params.system ? { instructions: params.system } : {}),
          ...(supportsCustomTemperature ? { temperature: params.temperature ?? 0.1 } : {}),
          ...(params.maxOutputTokens ? { max_output_tokens: params.maxOutputTokens } : {}),
        };
        const finalRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "x-lexprompt-region": params.compliance.region,
            "x-lexprompt-policy": params.compliance.policyVersion,
          },
          body: JSON.stringify(finalBody),
        });
        const finalData = await finalRes.json();
        if (!finalRes.ok) throw new Error(finalData.error?.message || retryMsg);
        return readResponseText(finalData);
      }

      throw new Error(msg);
    }
    const data = await res.json();
    let responseText = readResponseText(data);
    if (responseText) return responseText;

    const incompleteReason = data?.incomplete_details?.reason;
    const isTokenLimitedIncomplete = data?.status === "incomplete" && incompleteReason === "max_output_tokens";
    if (isTokenLimitedIncomplete) {
      const bumpedMaxTokens = Math.max((params.maxOutputTokens ?? 700) * 3, 1200);
      const retryBody: any = {
        ...baseBody,
        max_output_tokens: bumpedMaxTokens,
        ...(isGpt5Model ? { reasoning: { effort: "low" } } : {}),
      };
      if (params.responseSchema) {
        retryBody.text = {
          format: {
            type: "json_schema",
            name: "lexprompt_schema",
            schema: typeToJsonSchema(params.responseSchema),
            strict: true,
          },
        };
      }

      const retryRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "x-lexprompt-region": params.compliance.region,
          "x-lexprompt-policy": params.compliance.policyVersion,
        },
        body: JSON.stringify(retryBody),
      });
      const retryData = await retryRes.json();
      if (!retryRes.ok) {
        throw new Error(retryData.error?.message || "OpenAI API Error after max token retry");
      }
      responseText = readResponseText(retryData);
      if (responseText) return responseText;
      throw new Error("OpenAI returned no content after token-limit retry");
    }

    throw new Error(`OpenAI returned no content (status: ${data?.status || "unknown"})`);
  }

  if (provider === "anthropic") {
    const body: any = {
      model: params.model,
      max_tokens: params.maxOutputTokens ?? 4096,
      messages: [{ role: "user", content: params.prompt }],
      system: params.system,
      temperature: params.temperature ?? 0.1,
    };

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "x-lexprompt-region": params.compliance.region,
        "x-lexprompt-policy": params.compliance.policyVersion,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error?.message || "Anthropic API Error");
    }
    const data = await res.json();
    return data.content?.[0]?.text || "";
  }

  throw new Error("Unsupported Provider");
};

export const generateTemplate = async (
  contractType: string,
  depth: string,
  verbosity: string,
  context: string | undefined,
  compliance: ComplianceContext,
  preferredModel?: string
): Promise<Partial<Template>> => {
  const model = preferredModel || pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_MINI,
    AVAILABLE_MODELS.GEMINI_2_5_FLASH,
    AVAILABLE_MODELS.CLAUDE_HAIKU_4_5,
  ]);
  const prompt = `
    Create a contract review template for a "${contractType}".
    Context: ${context || "None"}
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
            riskCriteria: { type: Type.STRING },
          },
          required: ["title", "prompt"],
        },
      },
    },
    required: ["systemPrompt", "clauses"],
  };

  const text = await generateUniversalContent({
    model,
    prompt,
    responseSchema: schema,
    compliance,
  });

  if (text) return JSON.parse(text);
  throw new Error("Empty response from AI");
};

export const analyzeContract = async (
  template: Template,
  documents: DocumentFile[],
  selectedModel: string,
  compliance: ComplianceContext,
  isRedacted = false,
  onClauseProgress?: ClauseProgressCallback
): Promise<{ data: Record<string, any>; meta: AnalysisExecutionMeta }> => {
  let effectiveModel = selectedModel;
  if (getKeyPolicy() !== "platform" && !getApiKey(getProviderForModel(selectedModel))) {
    effectiveModel = pickBestAvailableModel([
      AVAILABLE_MODELS.GPT_5_MINI,
      AVAILABLE_MODELS.GEMINI_2_5_FLASH,
      AVAILABLE_MODELS.CLAUDE_SONNET_4_5,
    ]);
  }

  let fullText = documents.map((d) => `--- DOCUMENT: ${d.name} ---\n${d.content}`).join("\n\n");
  if (isRedacted) {
    fullText = fullText.replace(/[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g, "[REDACTED_EMAIL]");
    fullText = fullText.replace(/(?:\+?(\d{1,3}))?[-. (]*(\d{3})[-. )]*(\d{3})[-. ]*(\d{4})(?: *x(\d+))?/g, "[REDACTED_PHONE]");
  }
  const textForRetrieval = fullText
    .replace(/\r/g, "\n")
    .replace(/\[page\s+\d+\]\s*/gi, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const retrievalSegments = splitIntoSegments(textForRetrieval);
  const fallbackContext = (textForRetrieval || fullText).slice(0, MAX_CLAUSE_CONTEXT_CHARS);
  const clauseSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      summary: { type: Type.STRING },
      citations: { type: Type.ARRAY, items: { type: Type.STRING } },
      risk_level: { type: Type.STRING, enum: ["High", "Medium", "Low", "Info"] },
      risk_analysis: { type: Type.STRING },
    },
    required: ["summary", "citations", "risk_level", "risk_analysis"],
  };

  const findingsByClause: Record<string, any> = {};
  const clauseErrors: string[] = [];
  let completedCount = 0;
  const isRisk = template.mode === "risk";
  const clauseMaxOutputTokens = effectiveModel.startsWith("gpt-5")
    ? (isRisk ? 1400 : 900)
    : (isRisk ? 700 : 450);

  for (const clause of template.clauses) {
    onClauseProgress?.(clause.title, "queued", "Queued");
  }

  const runClause = async (clause: Clause): Promise<void> => {
    const riskCriteria = isRisk ? clause.riskCriteria || template.riskTolerance || "N/A" : "N/A";
    const clauseContext = selectClauseContext(retrievalSegments, clause, template, fallbackContext);
    onClauseProgress?.(clause.title, "running", `Running on ${effectiveModel}`);

    const buildPrompt = (retryMode = false) => `
You are analyzing one legal clause target for LexPrompt.
COMPLIANCE POLICY: region=${compliance.region}, noTraining=${compliance.noTraining}, minRetention=${compliance.minRetention}
FORMAT RULES: ${template.formatPrompt}
CLAUSE TITLE: ${clause.title}
CLAUSE INSTRUCTION: ${clause.prompt}
RISK MODE: ${isRisk ? "true" : "false"}
RISK CRITERIA: ${riskCriteria}

CITATION OUTPUT RULES (MANDATORY):
1) citations must be exact verbatim spans copied from the document text.
2) Return citation strings only. Do not include labels such as "Document:", "Page X", "Clause", bullets, or commentary.
3) If no exact verbatim support exists, return an empty citations array.
4) Keep citations precise and directly relevant to this clause finding.

BREVITY RULES (MANDATORY):
1) summary must be concise, plain English, max 2 sentences and <= 320 characters.
2) risk_analysis must be concise, plain English, max 2 sentences and <= ${MAX_RISK_ANALYSIS_CHARS} characters.
3) risk_analysis should only explain why the chosen risk_level applies using clause facts.
4) Do not include legal essay text, bullet lists, remediation playbooks, negotiation scripts, or disclaimers.
5) If RISK MODE is false, set risk_analysis to "".
${retryMode ? '6) CRITICAL: Output must be a single valid JSON object only, no prose before/after.' : ""}

Return only JSON with keys: summary, citations, risk_level, risk_analysis.

RELEVANT DOCUMENT EXCERPTS (verbatim):
${clauseContext}
`.trim();

    try {
      const generateClausePayload = async (retryMode = false): Promise<any> => {
        const text = await generateUniversalContent({
          model: effectiveModel,
          system: template.systemPrompt,
          prompt: buildPrompt(retryMode),
          responseSchema: clauseSchema,
          thinkingBudget: effectiveModel.includes("pro") || effectiveModel.includes("sonnet") ? 8000 : undefined,
          maxOutputTokens: retryMode ? clauseMaxOutputTokens + 500 : clauseMaxOutputTokens,
          compliance,
        });
        if (!text) {
          throw new Error("No analysis generated for clause");
        }
        return parseJsonSafe(text);
      };

      let parsed: any;
      try {
        parsed = await generateClausePayload(false);
      } catch (firstError: any) {
        const firstMessage = String(firstError?.message || "");
        if (!/invalid json/i.test(firstMessage)) {
          throw firstError;
        }
        parsed = await generateClausePayload(true);
      }

      const clausePayload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed.summary
            ? parsed
            : parsed[clause.title] || parsed.finding || parsed.result || parsed.data || parsed
          : parsed;

      const normalized = normalizeFinding(clausePayload);
      if (isRisk && !normalized.risk_analysis) {
        normalized.risk_analysis = buildFallbackRiskAnalysis(normalized.summary, normalized.risk_level);
      }
      findingsByClause[clause.title] = normalized;
      completedCount += 1;
      onClauseProgress?.(clause.title, "done", "Completed");
    } catch (error: any) {
      const detail = String(error?.message || "Clause analysis failed");
      clauseErrors.push(`${clause.title}: ${detail}`);
      findingsByClause[clause.title] = noResultFinding(
        `Clause analysis failed for "${clause.title}".`,
        detail
      );
      onClauseProgress?.(clause.title, "error", detail);
    }
  };

  const queue = [...template.clauses];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(CLAUSE_ANALYSIS_CONCURRENCY, queue.length || 1) }, async () => {
    while (nextIndex < queue.length) {
      const idx = nextIndex;
      nextIndex += 1;
      const clause = queue[idx];
      if (!clause) break;
      await runClause(clause);
    }
  });
  await Promise.all(workers);

  if (completedCount === 0 && clauseErrors.length > 0) {
    throw new Error(clauseErrors[0]);
  }

  for (const clause of template.clauses) {
    if (!findingsByClause[clause.title]) {
      findingsByClause[clause.title] = noResultFinding(`No result returned for "${clause.title}".`);
    }
  }

  const normalized = normalizeFindingsToTemplate(template, findingsByClause);
  if (isRisk) {
    for (const clauseTitle of Object.keys(normalized)) {
      const item = normalized[clauseTitle];
      if (!item) continue;
      const level = normalizeRiskLevel(item.risk_level);
      item.risk_level = level;
      if (!item.risk_analysis) {
        item.risk_analysis = buildFallbackRiskAnalysis(item.summary, level);
      }
    }
  }

  return {
    data: normalized,
    meta: {
      provider: getProviderForModel(effectiveModel),
      model: effectiveModel,
      region: compliance.region,
      policyVersion: compliance.policyVersion,
    },
  };
};

const defaultCompliance = (): ComplianceContext => ({
  region: "uk-london",
  residencyMode: "uk_preferred_eu_fallback",
  noTraining: true,
  minRetention: true,
  policyVersion: "beta-uk-eu-v1",
});

export const chatWithDoc = async (history: string, query: string, context: string): Promise<string> => {
  const model = pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_NANO,
    AVAILABLE_MODELS.GEMINI_2_5_FLASH_LITE,
    AVAILABLE_MODELS.CLAUDE_HAIKU_4_5,
  ]);
  const prompt = `
    CONTEXT: ${context.substring(0, 50000)}
    CHAT HISTORY: ${history}
    USER QUERY: ${query}
    Answer as a legal assistant. Be concise.
  `;
  const text = await generateUniversalContent({ model, prompt, compliance: defaultCompliance() });
  return text || "I could not generate a response.";
};

export const draftEmail = async (analysisJson: any): Promise<string> => {
  const model = pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_NANO,
    AVAILABLE_MODELS.GEMINI_2_5_FLASH_LITE,
    AVAILABLE_MODELS.CLAUDE_HAIKU_4_5,
  ]);
  const prompt = `Draft a professional email summary of these findings: ${JSON.stringify(analysisJson)}`;
  const text = await generateUniversalContent({ model, prompt, compliance: defaultCompliance() });
  return text || "Could not draft email.";
};

export const suggestRevision = async (clause: string, original: string, issue: string): Promise<string> => {
  const model = pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_MINI,
    AVAILABLE_MODELS.CLAUDE_SONNET_4_5,
    AVAILABLE_MODELS.GEMINI_2_5_PRO,
  ]);
  const prompt = `Mitigate risk for this clause. Clause: ${clause}\nOriginal: ${original}\nIssue: ${issue}`;
  const text = await generateUniversalContent({ model, prompt, compliance: defaultCompliance() });
  return text || "Could not generate revision.";
};

export const extractTabularData = async (docContent: string, query: string): Promise<any> => {
  const model = pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_NANO,
    AVAILABLE_MODELS.GEMINI_2_5_FLASH_LITE,
    AVAILABLE_MODELS.CLAUDE_HAIKU_4_5,
  ]);
  const prompt = `Document: ${docContent.substring(0, 30000)}\nQuery: "${query}"\nExtract JSON: {value, quote, confidence: 'High'|'Medium'|'Low'}`;
  const text = await generateUniversalContent({
    model,
    prompt,
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        value: { type: Type.STRING },
        quote: { type: Type.STRING },
        confidence: { type: Type.STRING, enum: ["High", "Medium", "Low"] },
      },
      required: ["value", "quote", "confidence"],
    },
    compliance: defaultCompliance(),
  });
  return JSON.parse(text);
};

export const analyzeTable = async (data: TabularData, columns: TabularColumn[], query: string): Promise<string> => {
  const model = pickBestAvailableModel([
    AVAILABLE_MODELS.GPT_5_MINI,
    AVAILABLE_MODELS.CLAUDE_SONNET_4_5,
    AVAILABLE_MODELS.GEMINI_2_5_PRO,
  ]);
  const prompt = `Strategic assessment for table: ${JSON.stringify(data)}\nQuery: ${query}`;
  const text = await generateUniversalContent({ model, prompt, thinkingBudget: 15000, compliance: defaultCompliance() });
  return text || "Could not analyze table.";
};
