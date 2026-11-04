import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Suscriptores del canal (push de eventos, para bots que SÍ atienden eventos
 * como GrokBot; opencode no: a ese se le invoca por polling+spawn).
 *
 * `bandeja/suscriptores.json`:
 *   { "grokbot": { "url": "https://...", "secreto": "..." } }
 *
 * Al crearse una tarea con `para` suscrito se le empuja `{evento:"tarea",...}`;
 * al caer un resultado con `de` suscrito se le empuja `{evento:"resultado",...}`.
 * Fire-and-forget con timeout: si el suscriptor no responde, la tarea sigue
 * viva en la bandeja y el polling la rescata. Nada aquí falla la petición.
 */

type Suscriptor = { url: string; secreto?: string };

export function cargarSuscriptores(
  bandejaDir: string,
): Record<string, Suscriptor> {
  try {
    const path = join(bandejaDir, "suscriptores.json");
    if (!existsSync(path)) return {};
    const json = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!json || typeof json !== "object") return {};
    const out: Record<string, Suscriptor> = {};
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(k)) continue;
      const s = v as { url?: unknown; secreto?: unknown };
      if (typeof s?.url !== "string" || !s.url.startsWith("http")) continue;
      out[k] = {
        url: s.url,
        ...(typeof s.secreto === "string" && s.secreto
          ? { secreto: s.secreto }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function empujar(
  bandejaDir: string,
  para: string,
  evento: "tarea" | "resultado",
  cuerpo: Record<string, unknown>,
): void {
  const sub = cargarSuscriptores(bandejaDir)[para];
  if (!sub) return;
  void (async () => {
    try {
      await fetch(sub.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(sub.secreto ? { authorization: `Bearer ${sub.secreto}` } : {}),
        },
        body: JSON.stringify({ evento, para, ...cuerpo }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {}
  })();
}
