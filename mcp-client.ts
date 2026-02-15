import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ServerConfig } from "./config.js";

interface ClientEntry {
  config: ServerConfig;
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  connected: boolean;
}

interface ConnectOptions {
  forceRefreshToken?: boolean;
}

interface TokenCacheEntry {
  token: string;
  fetchedAtMs: number;
}

export class McpClientPool {
  private clients = new Map<string, ClientEntry>();
  private tokenCache = new Map<string, TokenCacheEntry>();

  async connect(config: ServerConfig, options?: ConnectOptions): Promise<Client> {
    const client = new Client({ name: "openclaw-mcp-adapter", version: "0.1.1" });
    let transport = await this.createTransport(config, options);

    try {
      await client.connect(transport);
    } catch (err) {
      if (this.usesAuthTokenCommand(config) && this.isAuthError(err) && !options?.forceRefreshToken) {
        try {
          await transport.close?.();
        } catch {
          // ignore
        }
        transport = await this.createTransport(config, { forceRefreshToken: true });
        await client.connect(transport);
      } else {
        throw err;
      }
    }

    if (transport instanceof StdioClientTransport) {
      transport.onerror = () => this.markDisconnected(config.name);
      transport.onclose = () => this.markDisconnected(config.name);
    }

    this.clients.set(config.name, { config, client, transport, connected: true });
    return client;
  }

  private async createTransport(config: ServerConfig, options?: ConnectOptions) {
    if (config.transport === "http") {
      const headers = await this.buildHttpHeaders(config, options);
      return new StreamableHTTPClientTransport(new URL(config.url!), {
        requestInit: { headers },
      });
    }

    return new StdioClientTransport({
      command: config.command!,
      args: config.args,
      env: { ...process.env, ...config.env },
    });
  }

  private usesAuthTokenCommand(config: ServerConfig): boolean {
    return config.transport === "http" && Boolean(config.authTokenCommand);
  }

  private getTokenTtlMs(config: ServerConfig): number {
    const ttlSeconds = config.authTokenTtlSeconds ?? 2700;
    return Math.max(1, ttlSeconds) * 1000;
  }

  private async buildHttpHeaders(config: ServerConfig, options?: ConnectOptions): Promise<Record<string, string> | undefined> {
    const headers: Record<string, string> = { ...(config.headers ?? {}) };

    if (!this.usesAuthTokenCommand(config)) {
      return Object.keys(headers).length > 0 ? headers : undefined;
    }

    const token = await this.getAuthToken(config, options?.forceRefreshToken === true);
    const headerName = config.authTokenHeader || "Authorization";
    const prefix = config.authTokenPrefix ?? "Bearer";
    headers[headerName] = prefix ? `${prefix} ${token}` : token;

    return headers;
  }

  private async getAuthToken(config: ServerConfig, forceRefresh = false): Promise<string> {
    const cache = this.tokenCache.get(config.name);
    const now = Date.now();

    if (!forceRefresh && cache && now - cache.fetchedAtMs < this.getTokenTtlMs(config)) {
      return cache.token;
    }

    const args = [
      ...(config.authTokenArgs ?? []),
      ...(forceRefresh ? (config.authTokenRefreshArgs ?? []) : []),
    ];

    console.log(
      `[mcp-adapter] ${config.name}: requesting OAuth token${forceRefresh ? " (forced refresh)" : ""}`,
    );

    const token = await this.runTokenCommand(config.authTokenCommand!, args, config.env);
    this.tokenCache.set(config.name, { token, fetchedAtMs: now });
    return token;
  }

  private runTokenCommand(command: string, args: string[], env?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        {
          env: { ...process.env, ...env },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const msg = [stderr?.toString(), err.message].filter(Boolean).join(" | ");
            reject(new Error(`token command failed: ${msg}`));
            return;
          }

          const raw = (stdout ?? "").toString().trim();
          if (!raw) {
            reject(new Error("token command returned empty output"));
            return;
          }

          const token = this.extractToken(raw);
          if (!token) {
            reject(new Error("token command did not return a usable token"));
            return;
          }

          resolve(token);
        },
      );
    });
  }

  private extractToken(raw: string): string | null {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const candidate of [...lines].reverse()) {
      try {
        const parsed = JSON.parse(candidate) as Record<string, unknown>;
        const fromJson =
          (typeof parsed.access_token === "string" && parsed.access_token) ||
          (typeof parsed.token === "string" && parsed.token) ||
          (typeof parsed.bearer === "string" && parsed.bearer);
        if (fromJson) return fromJson;
      } catch {
        // not JSON line
      }
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const fromJson =
        (typeof parsed.access_token === "string" && parsed.access_token) ||
        (typeof parsed.token === "string" && parsed.token) ||
        (typeof parsed.bearer === "string" && parsed.bearer);
      if (fromJson) return fromJson;
    } catch {
      // not JSON payload
    }

    return lines[lines.length - 1] ?? null;
  }

  async listTools(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);

    try {
      const result = await entry.client.listTools();
      return result.tools;
    } catch (err) {
      if (this.usesAuthTokenCommand(entry.config) && this.isAuthError(err)) {
        await this.reconnect(serverName, { forceRefreshToken: true });
        const refreshed = this.clients.get(serverName)!;
        const result = await refreshed.client.listTools();
        return result.tools;
      }

      if (!entry.connected || this.isConnectionError(err)) {
        await this.reconnect(serverName);
        const refreshed = this.clients.get(serverName)!;
        const result = await refreshed.client.listTools();
        return result.tools;
      }

      throw err;
    }
  }

  async callTool(serverName: string, toolName: string, args: unknown) {
    const entry = this.clients.get(serverName);
    if (!entry) throw new Error(`Unknown server: ${serverName}`);

    try {
      return await entry.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
    } catch (err) {
      if (this.usesAuthTokenCommand(entry.config) && this.isAuthError(err)) {
        await this.reconnect(serverName, { forceRefreshToken: true });
        const refreshed = this.clients.get(serverName)!;
        return await refreshed.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
      }

      if (!entry.connected || this.isConnectionError(err)) {
        await this.reconnect(serverName);
        const refreshed = this.clients.get(serverName)!;
        return await refreshed.client.callTool({ name: toolName, arguments: args as Record<string, unknown> });
      }

      throw err;
    }
  }

  private async reconnect(serverName: string, options?: ConnectOptions) {
    const entry = this.clients.get(serverName);
    if (!entry) return;

    try {
      await entry.transport.close?.();
    } catch {
      // ignore close errors
    }

    await this.connect(entry.config, options);
  }

  private markDisconnected(serverName: string) {
    const entry = this.clients.get(serverName);
    if (entry) entry.connected = false;
  }

  private isConnectionError(err: unknown): boolean {
    const msg = String(err);
    return msg.includes("closed") || msg.includes("ECONNREFUSED") || msg.includes("EPIPE");
  }

  private isAuthError(err: unknown): boolean {
    const msg = String(err).toLowerCase();
    return (
      msg.includes("invalid_token") ||
      msg.includes("unauthorized") ||
      msg.includes("401") ||
      msg.includes("authentication") ||
      msg.includes("access token")
    );
  }

  getStatus(serverName: string) {
    const entry = this.clients.get(serverName);
    return { connected: entry?.connected ?? false };
  }

  async close(serverName: string) {
    const entry = this.clients.get(serverName);
    if (!entry) return;

    try {
      await entry.transport.close?.();
    } catch {
      // ignore close errors
    }

    this.clients.delete(serverName);
  }

  async closeAll() {
    for (const name of this.clients.keys()) {
      await this.close(name);
    }
  }
}
