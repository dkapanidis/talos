import { readFileSync, writeFileSync } from "fs";
import https from "https";
import type { TokenStoreConfig } from "./config.js";

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * A flat string->string record that survives restarts. The OAuth pair is one
 * such record; the remembered issue->repo mappings are another.
 */
export interface RecordStore {
  read(): Promise<Record<string, string> | null>;
  write(record: Record<string, string>): Promise<void>;
}

/**
 * Somewhere to keep the OAuth pair across restarts.
 *
 * Linear rotates the refresh token on every refresh and invalidates the old
 * one, so a refresh that is only held in memory works until the process dies
 * and then leaves the stored pair permanently stale. Anything that refreshes
 * needs to write the new pair back somewhere durable.
 */
export interface TokenStore {
  read(): Promise<OAuthTokens | null>;
  write(tokens: OAuthTokens): Promise<void>;
}

/** Discards writes. Used when no store is configured (local development). */
export class NullRecordStore implements RecordStore {
  async read(): Promise<Record<string, string> | null> {
    return null;
  }
  async write(): Promise<void> {
    /* nothing to do */
  }
}

/** Plain JSON file. Fine for a single-instance local run. */
export class FileRecordStore implements RecordStore {
  constructor(private path: string) {}

  async read(): Promise<Record<string, string> | null> {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf-8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object") return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  }

  async write(record: Record<string, string>): Promise<void> {
    writeFileSync(this.path, JSON.stringify(record, null, 2), { mode: 0o600 });
  }
}

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * A Kubernetes Secret in the pod's own namespace.
 *
 * Deliberately not the Secret that carries config.yaml: that one is owned by
 * external-secrets and is rewritten from Google Secret Manager on every sync
 * interval, which would silently undo anything written here. This is a
 * separate Secret that talos owns outright — it creates it on first write.
 *
 * Talks to the API server directly over https rather than pulling in a
 * Kubernetes client library, since it needs exactly two verbs.
 */
export class KubernetesSecretRecordStore implements RecordStore {
  private host: string;
  private port: string;
  private ca: Buffer;
  private saToken: string;

  constructor(
    private namespace: string,
    private name: string,
  ) {
    this.host = process.env.KUBERNETES_SERVICE_HOST ?? "kubernetes.default.svc";
    this.port = process.env.KUBERNETES_SERVICE_PORT ?? "443";
    this.ca = readFileSync(`${SA_DIR}/ca.crt`);
    this.saToken = readFileSync(`${SA_DIR}/token`, "utf-8").trim();
  }

  /** Namespace the pod is running in, per the projected service account volume. */
  static currentNamespace(): string | null {
    try {
      return readFileSync(`${SA_DIR}/namespace`, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  static isInCluster(): boolean {
    return (
      Boolean(process.env.KUBERNETES_SERVICE_HOST) &&
      KubernetesSecretRecordStore.currentNamespace() !== null
    );
  }

  private request(
    method: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<{ status: number; body: string }> {
    // POST targets the collection; GET and PATCH target the named resource.
    const collection = `/api/v1/namespaces/${this.namespace}/secrets`;
    const path = method === "POST" ? collection : `${collection}/${this.name}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.host,
          port: this.port,
          path,
          method,
          ca: this.ca,
          headers: {
            Authorization: `Bearer ${this.saToken}`,
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": contentType, "Content-Length": Buffer.byteLength(payload) }
              : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async read(): Promise<Record<string, string> | null> {
    const res = await this.request("GET");
    if (res.status === 404) return null;
    if (res.status >= 400) {
      throw new Error(`Failed to read secret ${this.namespace}/${this.name}: ${res.status} ${res.body}`);
    }
    const secret = JSON.parse(res.body) as { data?: Record<string, string> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(secret.data ?? {})) out[k] = decode(v);
    return out;
  }

  async write(record: Record<string, string>): Promise<void> {
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(record)) {
      data[k] = Buffer.from(v).toString("base64");
    }

    const patch = await this.request("PATCH", { data }, "application/merge-patch+json");
    if (patch.status < 400) return;

    if (patch.status === 404) {
      const create = await this.request("POST", {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: this.name, namespace: this.namespace },
        type: "Opaque",
        data,
      });
      if (create.status < 400) return;
      throw new Error(
        `Failed to create secret ${this.namespace}/${this.name}: ${create.status} ${create.body}`,
      );
    }

    throw new Error(
      `Failed to update secret ${this.namespace}/${this.name}: ${patch.status} ${patch.body}`,
    );
  }
}

function decode(value?: string): string {
  return value ? Buffer.from(value, "base64").toString("utf-8").trim() : "";
}

/** Adapts a RecordStore to the token pair. */
export class RecordTokenStore implements TokenStore {
  constructor(private store: RecordStore) {}

  async read(): Promise<OAuthTokens | null> {
    const rec = await this.store.read();
    if (!rec?.accessToken || !rec?.refreshToken) return null;
    return { accessToken: rec.accessToken, refreshToken: rec.refreshToken };
  }

  async write(tokens: OAuthTokens): Promise<void> {
    await this.store.write({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
  }
}

export class NullTokenStore extends RecordTokenStore {
  constructor() {
    super(new NullRecordStore());
  }
}

export class FileTokenStore extends RecordTokenStore {
  constructor(path: string) {
    super(new FileRecordStore(path));
  }
}

function recordStore(config: TokenStoreConfig, path: string, secretName: string): RecordStore {
  switch (config.kind) {
    case "file":
      return new FileRecordStore(path);
    case "kubernetes": {
      const namespace = config.namespace || KubernetesSecretRecordStore.currentNamespace();
      if (!namespace) {
        throw new Error(
          "tokenStore.kind is 'kubernetes' but no namespace was configured and the pod's " +
            "service account namespace file is unreadable — is this running in a cluster?",
        );
      }
      return new KubernetesSecretRecordStore(namespace, secretName);
    }
    case "none":
      return new NullRecordStore();
  }
}

export function createTokenStore(config: TokenStoreConfig): TokenStore {
  return new RecordTokenStore(recordStore(config, config.path, config.secretName));
}

/** Store for remembered team/label -> repo choices. Kept separate from the tokens. */
export function createRepoMemoryStore(config: TokenStoreConfig): RecordStore {
  return recordStore(config, config.repoPath, config.repoSecretName);
}
