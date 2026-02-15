export interface ServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  authTokenCommand?: string;
  authTokenArgs?: string[];
  authTokenRefreshArgs?: string[];
  authTokenHeader?: string;
  authTokenPrefix?: string;
  authTokenTtlSeconds?: number;
}

export interface McpAdapterConfig {
  servers: ServerConfig[];
  toolPrefix: boolean;
}

function interpolateString(v: string): string {
  return v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

function interpolateEnv(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = interpolateString(v);
  }
  return result;
}

function interpolateArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.map((v) => interpolateString(String(v)));
}

export function parseConfig(raw: unknown): McpAdapterConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;
  const servers: ServerConfig[] = [];

  for (const s of (cfg.servers as unknown[]) ?? []) {
    const srv = s as Record<string, unknown>;
    if (!srv.name) throw new Error("Server missing 'name'");

    const transport = (srv.transport as string) ?? "stdio";
    if (transport === "stdio" && !srv.command) throw new Error(`Server "${srv.name}" missing 'command'`);
    if (transport === "http" && !srv.url) throw new Error(`Server "${srv.name}" missing 'url'`);

    const authTokenCommand = srv.authTokenCommand ? String(srv.authTokenCommand) : undefined;
    const authTokenArgs = interpolateArray(srv.authTokenArgs);
    const authTokenRefreshArgs = interpolateArray(srv.authTokenRefreshArgs);
    const authTokenHeader = srv.authTokenHeader ? String(srv.authTokenHeader) : undefined;
    const authTokenPrefix = srv.authTokenPrefix ? String(srv.authTokenPrefix) : undefined;
    const authTokenTtlSeconds =
      typeof srv.authTokenTtlSeconds === "number"
        ? srv.authTokenTtlSeconds
        : srv.authTokenTtlSeconds != null
          ? Number(srv.authTokenTtlSeconds)
          : undefined;

    if ((authTokenArgs || authTokenRefreshArgs || authTokenHeader || authTokenPrefix || authTokenTtlSeconds != null) && !authTokenCommand) {
      throw new Error(`Server "${srv.name}" has authToken* settings but no authTokenCommand`);
    }

    servers.push({
      name: String(srv.name),
      transport: transport as "stdio" | "http",
      command: srv.command ? String(srv.command) : undefined,
      args: interpolateArray(srv.args),
      env: srv.env ? interpolateEnv(srv.env as Record<string, string>) : undefined,
      url: srv.url ? interpolateString(String(srv.url)) : undefined,
      headers: srv.headers ? interpolateEnv(srv.headers as Record<string, string>) : undefined,
      authTokenCommand,
      authTokenArgs,
      authTokenRefreshArgs,
      authTokenHeader,
      authTokenPrefix,
      authTokenTtlSeconds,
    });
  }

  return {
    servers,
    toolPrefix: cfg.toolPrefix !== false,
  };
}
