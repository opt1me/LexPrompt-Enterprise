import {
  type Template, type Clause, type Settings,
  TEMPLATE_SCHEMA_VERSION, DEFAULT_SETTINGS,
} from '../types';

const TEMPLATES_KEY = 'lexprompt.templates.v2';
const SETTINGS_KEY = 'lexprompt.settings';
const LAST_TIMESTAMP_KEY = 'lexprompt.lastTimestamp';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function getLastTimestamp(): number {
  try {
    const stored = localStorage.getItem(LAST_TIMESTAMP_KEY);
    return stored ? parseInt(stored, 10) : 0;
  } catch {
    return 0;
  }
}

function setLastTimestamp(timestamp: number): void {
  try {
    localStorage.setItem(LAST_TIMESTAMP_KEY, timestamp.toString());
  } catch {
    // Ignore errors
  }
}

function readAll(): Template[] {
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(migrate) : [];
  } catch {
    return [];
  }
}

function writeAll(templates: Template[]): void {
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
}

/** Brings a template of any earlier shape up to the current one. Anything
 *  missing gets a sane default rather than causing the template to be dropped. */
function migrate(input: unknown): Template {
  const t = input as Partial<Template> & Record<string, unknown>;
  const now = Date.now();
  return {
    id: typeof t.id === 'string' && t.id ? t.id : uid(),
    name: typeof t.name === 'string' ? t.name : 'Untitled template',
    contractType: typeof t.contractType === 'string' ? t.contractType : 'Custom',
    mode: t.mode === 'risk' ? 'risk' : 'extraction',
    systemPrompt: typeof t.systemPrompt === 'string' ? t.systemPrompt : '',
    formatPrompt: typeof t.formatPrompt === 'string' ? t.formatPrompt : '',
    riskTolerance: typeof t.riskTolerance === 'string' ? t.riskTolerance : undefined,
    clauses: Array.isArray(t.clauses) ? t.clauses.map(migrateClause) : [],
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

function migrateClause(input: unknown): Clause {
  const c = input as Partial<Clause>;
  return {
    id: typeof c.id === 'string' && c.id ? c.id : uid(),
    title: typeof c.title === 'string' ? c.title : 'Untitled clause',
    prompt: typeof c.prompt === 'string' ? c.prompt : '',
    riskCriteria: typeof c.riskCriteria === 'string' ? c.riskCriteria : undefined,
  };
}

export function newTemplate(name: string): Template {
  const now = Date.now();
  return {
    id: uid(),
    name,
    contractType: 'Custom',
    mode: 'extraction',
    systemPrompt: 'You are an expert legal contract reviewer.',
    formatPrompt: 'Answer strictly from the document text. Quote verbatim.',
    clauses: [],
    createdAt: now,
    updatedAt: now,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
  };
}

export async function listTemplates(): Promise<Template[]> {
  return readAll().sort((a, b) => {
    const diff = b.updatedAt - a.updatedAt;
    if (diff !== 0) return diff;
    // Tiebreaker: if two templates have the same updatedAt, sort by id to ensure deterministic order
    return b.id.localeCompare(a.id);
  });
}

export async function getTemplate(id: string): Promise<Template | null> {
  return readAll().find(t => t.id === id) ?? null;
}

export async function saveTemplate(template: Template): Promise<Template> {
  // Ensure monotonically increasing timestamps to prevent flakiness
  const now = Date.now();
  const lastTimestamp = getLastTimestamp();
  let timestamp = now;

  if (now <= lastTimestamp) {
    // Same or earlier millisecond; increment from last timestamp
    timestamp = lastTimestamp + 1;
  } else {
    timestamp = now;
  }

  setLastTimestamp(timestamp);

  const saved: Template = { ...template, updatedAt: timestamp, schemaVersion: TEMPLATE_SCHEMA_VERSION };
  const all = readAll();
  const idx = all.findIndex(t => t.id === saved.id);
  if (idx >= 0) all[idx] = saved;
  else all.push(saved);
  writeAll(all);
  return saved;
}

export async function deleteTemplate(id: string): Promise<void> {
  writeAll(readAll().filter(t => t.id !== id));
}

export function exportTemplate(template: Template): Blob {
  return new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
}

export async function importTemplate(json: string): Promise<Template> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { clauses?: unknown }).clauses)) {
    throw new Error('That file is not a template — it has no clauses.');
  }
  const migrated = migrate(parsed);
  // Fresh id so importing a template you already have does not overwrite it.
  return saveTemplate({ ...migrated, id: uid() });
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
