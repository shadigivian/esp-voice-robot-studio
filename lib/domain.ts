export type MemberRole = "owner" | "admin" | "viewer";
export interface Actor {
  userId: string;
  workspaceId: string;
  role: MemberRole;
}
export interface Role {
  title: string;
  mission: string;
  tasks: string[];
  restrictions: string[];
  audience: string;
  unknownResponse: string;
  scope: string;
}
export interface Character {
  name: string;
  description: string;
  icon: string;
  tone: string;
  patience: string;
  humor: string;
  responseLength: string;
  language: string;
  languages: string[];
  voice: string;
  greeting: string;
  instructions: string;
  templateId?: string;
}
export interface DeviceConfig {
  role: Role;
  character: Character;
  knowledgeMode: "strict_sources" | "hybrid";
  activeSourceIds: string[];
}
export interface ConfigVersion {
  version: number;
  createdAt: string;
  config: DeviceConfig;
  actorId: string;
}
export interface DocumentRevision {
  revision: number;
  text: string;
  createdAt: string;
  status: string;
  providerFileId?: string;
}
export interface Document {
  id: string;
  title: string;
  revision: number;
  text: string;
  status:
    | "uploaded"
    | "extracting"
    | "needs_review"
    | "approved"
    | "indexing"
    | "ready"
    | "failed"
    | "deleted";
  active: boolean;
  createdAt: string;
  error: string | null;
  mimeType: string;
  history: DocumentRevision[];
  approvedRevision?: number;
  readyRevision?: number;
  readyText?: string;
  providerFileId?: string;
  activeRevision?: number;
  activeText?: string;
  activeFileId?: string;
  indexJobId?: string;
}
export interface VerifiedFact {
  id: string;
  key: string;
  value: string;
  unit: string;
  verifiedAt: string;
  revision: number;
  history: {
    value: string;
    unit: string;
    verifiedAt: string;
    revision: number;
  }[];
}
export interface Command {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  expiresAt: string;
  status: "pending" | "applied" | "failed";
  error: string | null;
  createdAt: string;
}
export interface Claim {
  id: string;
  expiresAt: string;
  attempts: number;
  status:
    "pending" | "displayed" | "verified" | "consumed" | "expired" | "locked";
}
export interface Device {
  id: string;
  workspaceId: string;
  name: string;
  mac: string;
  provisioning: "pending" | "paired" | "revoked";
  connectivity: "unknown" | "online" | "offline";
  conversation:
    "idle" | "connecting" | "listening" | "processing" | "speaking" | "error";
  lastSeen: string | null;
  capabilities: string[];
  draft: DeviceConfig;
  published: DeviceConfig | null;
  configVersion: number;
  appliedVersion: number | null;
  history: ConfigVersion[];
  documents: Document[];
  facts: VerifiedFact[];
  commands: Command[];
  privacy: { storeTranscripts: boolean; retentionDays: number };
  claim: Claim | null;
  knowledgeEpoch: number;
  demo?: boolean;
}
export interface CharacterTemplate {
  id: string;
  workspaceId: string;
  name: string;
  version: number;
  character: Character;
  archived: boolean;
  history: { version: number; character: Character; createdAt: string }[];
}
export interface Session {
  id: string;
  workspaceId: string;
  deviceId: string;
  type: "test" | "live";
  startedAt: string;
  endedAt: string | null;
  configVersion: number;
  knowledgeEpoch: number;
  status: "active" | "ended" | "revoked" | "error";
  transcriptStored: boolean;
  messages: { role: "user" | "assistant"; text: string; at: string }[];
  error: string | null;
  usage: Record<string, number> | null;
  configSnapshot?: DeviceConfig;
  draftPreview?: boolean;
  usageEventIds?: string[];
  createdBy?: string;
  browserCallId?: string;
  browserLastClientSeen?: string;
  browserControlSeen?: string;
  browserDeadline?: string;
  browserHangupPending?: boolean;
  deleted?: boolean;
}
export interface Source {
  sourceId: string;
  revision: number;
  title: string;
  excerpt: string;
  score?: number;
}
export interface AuditEvent {
  id: string;
  workspaceId: string;
  actorId: string;
  action: string;
  deviceId?: string;
  at: string;
}
export interface Integrations {
  database: string;
  auth: string;
  openai: string;
  voiceServer: string;
  model: string | null;
  voiceEndpoint: string | null;
}
export interface Bootstrap {
  demo: boolean;
  user: { id: string; role: MemberRole; workspaceId: string };
  workspace: { id: string; name: string };
  devices: Device[];
  templates: CharacterTemplate[];
  sessions: Session[];
  integrations: Integrations;
  stats: {
    online: number;
    totalDevices: number;
    activeSources: number;
    sessions: number;
    usage: Record<string, number> | null;
  };
  audit: AuditEvent[];
}
export const defaultRole: Role = {
  title: "راهنمای عمومی",
  mission: "راهنمایی دقیق و روشن",
  tasks: ["پاسخ‌گویی به پرسش‌های مرتبط"],
  restrictions: [
    "اطلاعات اختصاصی را حدس نزن",
    "ادعای انجام عملیات بدون ابزار نکن",
  ],
  audience: "مراجعه‌کنندگان",
  unknownResponse: "اطلاعات تأییدشده‌ای در این مورد ندارم.",
  scope: "موضوعات مرتبط با وظایف دستگاه",
};
export const defaultCharacter: Character = {
  name: "همراه",
  description: "دستیار هوش مصنوعی",
  icon: "✦",
  tone: "friendly",
  patience: "high",
  humor: "low",
  responseLength: "short",
  language: "fa",
  languages: ["fa"],
  voice: "",
  greeting: "سلام، من دستیار هوش مصنوعی شما هستم.",
  instructions: "",
};
export function defaultConfig(): DeviceConfig {
  return structuredClone({
    role: defaultRole,
    character: defaultCharacter,
    knowledgeMode: "strict_sources" as const,
    activeSourceIds: [],
  });
}
