import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credenciales del canal: cada bot/agente se registra una vez con el secreto
 * de alta (bootstrap) y recibe `uuid + token`. El token viaja como
 * `Authorization: Bearer cb_...`; en disco/BD solo vive su hash SHA-256.
 * Sin correo, sin personas: es un canal para IAs, usable con curl.
 */

const PREFIJO = "cb_";
const TOKEN_BYTES = 32;

export function nuevoId(): string {
  return crypto.randomUUID();
}

export function nuevoToken(): string {
  return PREFIJO + randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Extrae el token del header. Devuelve null si no hay Bearer bien formado. */
export function extraerBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer ([A-Za-z0-9\-_]{10,128})$/.exec(h.trim());
  return m ? m[1] : null;
}

/** Comparación en tiempo constante (bootstrap y hashes). */
export function igualSecreto(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export const NOMBRE_RE = /^[a-z0-9_-]{1,32}$/;

/** Normaliza el nombre de agente: minúsculas, sin espacios. */
export function normalizarNombre(nombre: unknown): string | null {
  if (typeof nombre !== "string") return null;
  const n = nombre.trim().toLowerCase();
  return NOMBRE_RE.test(n) ? n : null;
}

/**
 * Límite de velocidad en memoria (una instancia = un mapa; en Render free hay
 * una sola instancia, así que basta. Si se escala a N instancias, mover a BD).
 */
export function crearLimite(max: number, ventanaMs: number) {
  const golpes = new Map<string, { n: number; reset: number }>();
  return (clave: string): boolean => {
    const ahora = Date.now();
    const r = golpes.get(clave);
    if (!r || ahora > r.reset) {
      golpes.set(clave, { n: 1, reset: ahora + ventanaMs });
      return true;
    }
    r.n += 1;
    if (golpes.size > 10000) golpes.clear();
    return r.n <= max;
  };
}
