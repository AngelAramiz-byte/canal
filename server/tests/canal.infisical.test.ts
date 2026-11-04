import { describe, expect, test } from "bun:test";
import { _limpiarCache, cargarSecretos } from "../src/canal/infisical";

function env(base: Record<string, string>) {
  return base as unknown as NodeJS.ProcessEnv;
}

describe("infisical: orden env → nube → error", () => {
  test("env completo no toca red", async () => {
    _limpiarCache();
    const sec = await cargarSecretos(
      env({ CANAL_BOOTSTRAP: "b", CANAL_DATABASE_URL: "postgresql://x" }),
    );
    expect(sec).toEqual({ bootstrap: "b", databaseUrl: "postgresql://x" });
  });

  test("sin nada: error claro", async () => {
    _limpiarCache();
    await expect(cargarSecretos(env({}))).rejects.toThrow("Sin secretos");
  });

  test("vía nube con fetch simulado + caché", async () => {
    _limpiarCache();
    let llamadas = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
      llamadas += 1;
      const u = String(url);
      if (u.endsWith("/api/v1/auth/universal-auth/login"))
        return Response.json({ accessToken: "tok" });
      if (u.includes("/api/v3/secrets/raw"))
        return Response.json({
          secrets: [
            { secretKey: "CANAL_BOOTSTRAP", secretValue: "nb" },
            { secretKey: "CANAL_DATABASE_URL", secretValue: "nd" },
          ],
        });
      throw new Error(`inesperado: ${u} ${JSON.stringify(init?.body)}`);
    }) as typeof fetch;
    try {
      const e = env({
        INFISICAL_CLIENT_ID: "id",
        INFISICAL_CLIENT_SECRET: "sec",
        INFISICAL_PROJECT_ID: "p",
      });
      const s1 = await cargarSecretos(e);
      expect(s1).toEqual({ bootstrap: "nb", databaseUrl: "nd" });
      const s2 = await cargarSecretos(e);
      expect(s2).toEqual(s1);
      expect(llamadas).toBe(2); // login + lectura; la segunda va al caché
    } finally {
      globalThis.fetch = real;
      _limpiarCache();
    }
  });
});
