export type LLMProvider =
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'together'
  | 'abacus'
  | 'deepseek'
  | 'ollama'
  | 'custom';

export interface ProviderConfig {
  id: LLMProvider;
  name: string;
  baseUrl: string;
  models: string[];
  requiresApiKey: boolean;
  description: string;
}

// Curated default model lists, ordered best-first for grammar/writing
// correction (strong instruction-following + low latency, cost-effective).
// When an API key is set these are refined by the provider's live /models
// list; obsolete/decommissioned models have been removed.
// The extension calls LLM providers directly (no backend), so this client
// copy is the source of truth for provider/model configuration.
export const PROVIDERS: ProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1'],
    requiresApiKey: true,
    description: 'Official OpenAI API',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-haiku',
      'meta-llama/llama-3.3-70b-instruct',
      'google/gemini-2.0-flash-001',
    ],
    requiresApiKey: true,
    description: 'Access 100+ models with one API',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Ordered by OGrammar proofreading benchmark (docs/25): gpt-oss-20b best
    // quality (117/123), llama-3.3-70b fastest (~400ms), 8b-instant cheapest.
    // (Live /models replaces this when a key is set; gemma2-9b-it is deprecated.)
    models: [
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
    ],
    requiresApiKey: true,
    description: 'Blazing fast inference',
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo',
    ],
    requiresApiKey: true,
    description: 'Open source models at scale',
  },
  {
    id: 'abacus',
    name: 'Abacus RouteLLM',
    baseUrl: 'https://routellm.abacus.ai/v1',
    models: ['route-llm', 'claude-haiku-4.5', 'claude-sonnet-4.5', 'gpt-5.2-pro'],
    requiresApiKey: true,
    description: 'Smart routing across top models (OpenAI-compatible)',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    // deepseek-chat (V3) is the recommended proofreading model: in local
    // benchmarking (docs/25) it scored highest of every model tested — near
    // perfect, zero hard failures, perfect protected-span preservation.
    // deepseek-reasoner (R1, thinking) is slower and occasionally breaks strict
    // JSON, so it is listed second.
    models: ['deepseek-chat', 'deepseek-reasoner'],
    requiresApiKey: true,
    description: 'DeepSeek V3 / R1 (OpenAI-compatible). deepseek-chat recommended.',
  },
  {
    id: 'ollama',
    // Models are read live from the server's native /api/tags (real
    // installed tags). No static list: bare names like "qwen2.5" 404
    // when only "qwen2.5:7b" is pulled, and a fake list when the server
    // is unreachable is worse than an honest empty one.
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    models: [],
    requiresApiKey: false,
    description: 'Run models locally on your machine',
  },
  {
    id: 'custom',
    name: 'Custom Endpoint',
    baseUrl: '',
    models: [],
    requiresApiKey: true,
    description: 'Your own OpenAI-compatible API',
  },
];

export interface Issue {
  type: 'grammar' | 'spelling' | 'clarity' | 'style';
  original: string;
  suggestion: string;
  reason: string;
  offset: number;
  length: number;
  id?: string;
  ignored?: boolean;
  confidence?: number;
  priority?: number;
  source?: 'rule' | 'llm' | 'context' | 'learned';
  route?: 'quick-fix' | 'sentence-review' | 'suppress';
  routeReason?: string;
}

export interface IgnoredIssue {
  id: string;
  type: Issue['type'];
  original: string;
  suggestion: string;
  ignoredAt: number;
}

export interface AnalyzeRequest {
  text: string;
  apiKey?: string;
  model?: string;
  provider?: LLMProvider;
  baseUrl?: string;
  ignoredIssues?: string[];
  dictionary?: string[];
  context?: AnalysisContext;
  disabledModules?: string[];
  /** Ollama-only: idle keep-alive token ("0","30s","2m","5m","-1"). */
  keepAlive?: string;
}

export interface AnalysisContext {
  domain?: string;
  editorType?: string;
  activeSentence?: string;
  previousText?: string;
  nextText?: string;
  fullTextExcerpt?: string;
  /** Page title + URL + trimmed main visible text, so the grammar/AI review
   *  can ground its suggestions in what the user is actually reading. */
  pageContext?: string;
}

export interface AnalyzeResponse {
  issues: Issue[];
  metadata?: {
    textLength: number;
    issuesCount: number;
    processingTimeMs: number;
    contextUsed?: boolean;
    model?: string;
    provider?: string;
  };
  error?: string;
  message?: string;
}

export interface RewriteRequest {
  text: string;
  /** A tone id from shared/prompts.json (polish | formal | casual). */
  tone: string;
  apiKey?: string;
  model?: string;
  provider?: LLMProvider;
  baseUrl?: string;
  /** Ollama-only: idle keep-alive token ("0","30s","2m","5m","-1"). */
  keepAlive?: string;
}

export interface RewriteResponse {
  original: string;
  rewritten: string;
  tone: string;
  error?: string;
}

export interface EditorContext {
  text: string;
  issues: Issue[];
  sourceTabId?: number;
  capturedAt: number;
}

export type AnalyticsEventType =
  | 'analysis_runs'
  | 'issues_found'
  | 'suggestions_applied'
  | 'suggestions_ignored'
  | 'rewrite_opened'
  | 'rewrite_applied';

export interface AnalyticsSummary {
  totals: Record<AnalyticsEventType, number>;
  domains: Record<string, number>;
  providers: Record<string, number>;
  lastUpdatedAt?: number;
}
