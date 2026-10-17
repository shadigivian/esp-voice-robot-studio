import type {
  Actor,
  AuditEvent,
  CharacterTemplate,
  Device,
  Session,
} from "../domain";
export interface Workspace {
  id: string;
  name: string;
  demo: boolean;
  usageByDay?: {
    date: string;
    deviceId: string;
    values: Record<string, number>;
    sessions?: number;
  }[];
}
export type Membership = Actor;
export interface BootstrapIdentity {
  mac: string;
  hash: string;
}
export interface SecretClaim {
  id: string;
  workspaceId: string;
  deviceId: string;
  mac: string;
  codeHash: string | null;
  connectionId: string | null;
  nonceHash: string | null;
  expiresAt: string;
  attempts: number;
  status:
    "pending" | "displayed" | "verified" | "consumed" | "expired" | "locked";
  issuedAt: string | null;
}
export interface Credential {
  id: string;
  workspaceId: string;
  deviceId: string;
  tokenHash: string;
  refreshHash: string;
  expiresAt: string;
  refreshExpiresAt: string;
  revoked: boolean;
}
export interface IngestionJob {
  id: string;
  workspaceId: string;
  deviceId: string;
  documentId: string;
  revision: number;
  text: string;
  status: "queued" | "running" | "completed" | "failed" | "superseded";
  leaseUntil: string | null;
  attempts: number;
  error: string | null;
  providerFileId?: string;
  cleanup?: boolean;
}
export interface State {
  workspaces: Workspace[];
  members: Membership[];
  devices: Device[];
  templates: CharacterTemplate[];
  sessions: Session[];
  audit: AuditEvent[];
  identities: BootstrapIdentity[];
  claims: SecretClaim[];
  credentials: Credential[];
  jobs: IngestionJob[];
  vectorStores: { deviceId: string; workspaceId: string; providerId: string }[];
  rateLimits: {
    key: string;
    window: number;
    count: number;
    expiresAt?: number;
  }[];
}
export function emptyState(): State {
  return {
    workspaces: [],
    members: [],
    devices: [],
    templates: [],
    sessions: [],
    audit: [],
    identities: [],
    claims: [],
    credentials: [],
    jobs: [],
    vectorStores: [],
    rateLimits: [],
  };
}
export interface StateStore {
  transaction<T>(operation: (state: State) => T | Promise<T>): Promise<T>;
  close?(): Promise<void>;
}
/** Explicit demo/test storage only. A failed operation rolls back its private copy. */
export class MemoryStore implements StateStore {
  private state: State;
  private tail: Promise<void> = Promise.resolve();
  constructor(state = emptyState()) {
    this.state = structuredClone(state);
  }
  async transaction<T>(
    operation: (state: State) => T | Promise<T>,
  ): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const copy = structuredClone(this.state);
      const result = await operation(copy);
      this.state = copy;
      return structuredClone(result);
    } finally {
      release();
    }
  }
}
