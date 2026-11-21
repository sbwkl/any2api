// codebuddy provider 公共类型
export interface Credentials {
  accessToken: string;
  refreshToken?: string;
  uid: string;
  domain?: string;
  expiresAt?: number;
  source: "keychain" | "env" | "session-json";
}

export interface ModelInfo {
  id: string;
  name: string;
  vendor?: string;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  supportsToolCall?: boolean;
  supportsReasoning?: boolean;
  supportedEfforts?: string[];
  contextLength?: number;
  temperature?: number;
  tags?: string[];
}

export interface PromptEntry {
  name: string;
  template: string;
  tags?: string[];
}

export interface AgentEntry {
  name: string;
  description?: string;
  instructions?: string;
  models?: string[];
  tools?: string[];
}

export interface ProductConfig {
  endpoint: string;
  productName: string;
  platform: string;
  deploymentType: string;
  version: string;
  models: ModelInfo[];
  agents: AgentEntry[];
  prompts: PromptEntry[];
  authentication?: {
    id?: string;
    type?: string;
    attributes?: Record<string, unknown>;
  };
}

export type Profile = "chat" | "ask" | "craft";

export interface ChatRequest {
  model: string;
  messages: Array<Record<string, any>>;
  stream?: boolean;
  tools?: Array<Record<string, any>>;
  tool_choice?: any;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  reasoning_effort?: string;
  [key: string]: any;
}