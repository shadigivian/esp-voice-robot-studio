import type { Source } from "../domain";
import { AppError, assert } from "./errors";

export interface KnowledgeProvider {
  createStore(deviceId: string): Promise<string>;
  index(
    storeId: string,
    text: string,
    meta: {
      documentId: string;
      revision: number;
      title: string;
      jobId: string;
    },
  ): Promise<string>;
  status(
    storeId: string,
    fileId: string,
  ): Promise<"ready" | "indexing" | "failed">;
  search(
    storeId: string,
    query: string,
  ): Promise<(Source & { fileId?: string })[]>;
  remove(storeId: string, fileId: string): Promise<void>;
}
/** API origin is fixed. No browser supplied URL, store or file identifier is used. */
export class OpenAIKnowledgeProvider implements KnowledgeProvider {
  constructor(private key: string) {
    assert(key, "SETUP_REQUIRED", "OpenAI key is not configured.", 503);
  }
  private async request(
    path: string,
    init: RequestInit = {},
    allowMissing = false,
  ) {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.key}`);
    if (init.body && !(init.body instanceof FormData))
      headers.set("Content-Type", "application/json");
    const response = await fetch(`https://api.openai.com/v1${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(25000),
    });
    if (allowMissing && response.status === 404) return {};
    if (!response.ok)
      throw new AppError(
        "PROVIDER_ERROR",
        `Knowledge provider returned HTTP ${response.status}.`,
        502,
      );
    return response.status === 204 ? {} : response.json();
  }
  async createStore(deviceId: string) {
    const result = await this.request("/vector_stores", {
      method: "POST",
      body: JSON.stringify({ name: `device-${deviceId}` }),
    });
    return result.id as string;
  }
  async index(
    storeId: string,
    text: string,
    meta: {
      documentId: string;
      revision: number;
      title: string;
      jobId: string;
    },
  ) {
    const form = new FormData();
    form.set("purpose", "assistants");
    form.set(
      "file",
      new Blob([text], { type: "text/plain" }),
      `${meta.documentId}-r${meta.revision}.txt`,
    );
    const file = await this.request("/files", {
      method: "POST",
      headers: { "Idempotency-Key": meta.jobId },
      body: form,
    });
    try {
      await this.request(
        `/vector_stores/${encodeURIComponent(storeId)}/files`,
        {
          method: "POST",
          body: JSON.stringify({
            file_id: file.id,
            attributes: {
              source_id: meta.documentId,
              revision: meta.revision,
              title: meta.title.slice(0, 256),
            },
          }),
        },
      );
    } catch (error) {
      await this.request(`/files/${encodeURIComponent(file.id)}`, {
        method: "DELETE",
      }).catch(() => {});
      throw error;
    }
    return file.id as string;
  }
  async status(storeId: string, fileId: string) {
    const file = await this.request(
      `/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`,
    );
    return file.status === "completed"
      ? "ready"
      : file.status === "in_progress"
        ? "indexing"
        : "failed";
  }
  async search(storeId: string, query: string) {
    const result = await this.request(
      `/vector_stores/${encodeURIComponent(storeId)}/search`,
      {
        method: "POST",
        body: JSON.stringify({
          query,
          max_num_results: 12,
          rewrite_query: false,
        }),
      },
    );
    return (result.data ?? []).map(
      (item: {
        attributes?: { source_id?: string; revision?: number; title?: string };
        content?: { text?: string }[];
        score?: number;
        file_id?: string;
      }) => ({
        sourceId: item.attributes?.source_id ?? "",
        revision: Number(item.attributes?.revision ?? 0),
        title: item.attributes?.title ?? "",
        excerpt: (item.content ?? [])
          .map((part) => part.text ?? "")
          .join("\n")
          .slice(0, 2500),
        score: item.score,
        fileId: item.file_id,
      }),
    );
  }
  async remove(storeId: string, fileId: string) {
    await this.request(
      `/vector_stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
      true,
    );
    await this.request(
      `/files/${encodeURIComponent(fileId)}`,
      { method: "DELETE" },
      true,
    );
  }
}
/** Demo retrieval is visibly synthetic and cannot call a paid provider. */
export class DemoKnowledgeProvider implements KnowledgeProvider {
  async createStore(deviceId: string) {
    return `demo-${deviceId}`;
  }
  async index(
    _store: string,
    _text: string,
    meta: { documentId: string; revision: number },
  ) {
    return `demo-${meta.documentId}-${meta.revision}`;
  }
  async status() {
    return "ready" as const;
  }
  async search() {
    return [];
  }
  async remove() {}
}
