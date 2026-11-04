/**
 * Secretos del canal vía Infisical (Universal Auth, REST nativo) con
 * fallback a variables de entorno. Orden:
 * 1. Si el env ya trae CANAL_BOOTSTRAP y CANAL_DATABASE_URL → env (dev local).
 * 2. Si hay INFISICAL_CLIENT_ID/SECRET → login, lee, cachea 10 min en memoria.
 * 3. Si no → error claro (el server no arranca a ciegas).
 *
 * Solo el server usa identidad máquina; los bots reciben su token una vez
 * (humano) y lo guardan en su config. Así gastamos 1 identidad, no N.
 */

export type SecretosCanal = {
  bootstrap: string;
  databaseUrl: string;
};

type Cache = { hasta: number; sec: SecretosCanal };
let cache: Cache | null = null;

const NOMBRES = ["CANAL_BOOTSTRAP", "CANAL_DATABASE_URL"] as const;

async function login(
  base: string,
  id: string,
  secret: string,
): Promise<string> {
  const r = await fetch(`${base}/api/v1/auth/universal-auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: id, clientSecret: secret }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`infisical login ${r.status}`);
  const j = (await r.json()) as { accessToken?: string };
  if (!j.accessToken) throw new Error("infisical sin accessToken");
  return j.accessToken;
}

async function leer(
  base: string,
  token: string,
  proyecto: string,
  entorno: string,
): Promise<Record<string, string>> {
  const q = new URLSearchParams({
    workspaceId: proyecto,
    environment: entorno,
    secretPath: "/",
  });
  const r = await fetch(`${base}/api/v3/secrets/raw?${q}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`infisical lectura ${r.status}`);
  const j = (await r.json()) as {
    secrets?: { secretKey: string; secretValue: string }[];
  };
  const out: Record<string, string> = {};
  for (const s of j.secrets ?? []) out[s.secretKey] = s.secretValue;
  return out;
}

export async function cargarSecretos(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretosCanal> {
  const bEnv = (env.CANAL_BOOTSTRAP ?? "").trim();
  const dEnv = (env.CANAL_DATABASE_URL ?? "").trim();
  if (bEnv && dEnv) return { bootstrap: bEnv, databaseUrl: dEnv };

  const id = (env.INFISICAL_CLIENT_ID ?? "").trim();
  const secret = (env.INFISICAL_CLIENT_SECRET ?? "").trim();
  if (!id || !secret)
    throw new Error(
      "Sin secretos: pon CANAL_* en env o INFISICAL_CLIENT_ID/SECRET.",
    );

  const ahora = Date.now();
  if (cache && ahora < cache.hasta) return cache.sec;

  const base = (env.INFISICAL_URL ?? "https://app.infisical.com").replace(
    /\/$/,
    "",
  );
  const proyecto =
    (env.INFISICAL_PROJECT_ID ?? "").trim() ||
    (env.INFISICAL_PROJECT_SLUG ?? "").trim();
  if (!proyecto) throw new Error("Falta INFISICAL_PROJECT_ID (o _SLUG).");
  const entorno = (env.INFISICAL_ENV ?? "prod").trim() || "prod";

  const token = await login(base, id, secret);
  const sec = await leer(base, token, proyecto, entorno);
  const bootstrap = (sec[NOMBRES[0]] ?? "").trim();
  const databaseUrl = (sec[NOMBRES[1]] ?? "").trim();
  if (!bootstrap || !databaseUrl)
    throw new Error("Infisical no trae CANAL_BOOTSTRAP ni CANAL_DATABASE_URL.");
  cache = { hasta: ahora + 10 * 60_000, sec: { bootstrap, databaseUrl } };
  return cache.sec;
}

/** Solo tests: limpia el caché en memoria. */
export function _limpiarCache() {
  cache = null;
}
