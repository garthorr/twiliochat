export interface Config {
  port: number;
  host: string;
  databaseUrl: string;
  publicDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: env.PORT ? Number(env.PORT) : 8080,
    host: env.HOST ?? "0.0.0.0",
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://twiliochat:twiliochat@localhost:5432/twiliochat",
    publicDir: env.PUBLIC_DIR ?? null,
  };
}
