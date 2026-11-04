import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import {
  DEPLOYMENT_INITIATOR,
  recordAuditEvent,
  type AuditStore,
} from "../audit";
import { empujar } from "./suscriptores";
import { sameToken } from "../agents/callback-token";

/**
 * Delegaciones bot-a-bot (A2A-lite, sin chat).
 *
 * Un bot externo (GrokBot, un segundo OpenBot, un script) deja una tarea en la
 * bandeja compartida y la consulta por polling. El chat nunca interviene: el
 * relevo es proceso a proceso y solo el resumen llega al canal vía el ejecutor.
 *
 * Autenticación: el mismo secreto compartido del worker (`WORKER_SHARED_SECRET`).
 * Es la credencial de "bots de este despliegue", no de personas; por eso estas
 * rutas no pasan por requireUser, igual que `/internal/routines/run`.
 */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAREA_MAX = 8000;

function defaultBandejaDir(): string {
  // Este archivo vive en server/src/delegaciones/: cuatro niveles arriba
  // está la raíz de OPBT y la bandeja cuelga de plataforma/.
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "..", "..", "..", "bandeja");
}

export function createDelegacionesRoutes(options: {
  workerSecret?: string;
  auditStore?: AuditStore;
  bandejaDir?: string;
}) {
  const { workerSecret, auditStore } = options;
  const bandejaDir = options.bandejaDir ?? defaultBandejaDir();
  const routes = new Hono();

  const secreto = workerSecret?.trim() ? workerSecret.trim() : null;
  const refused = (
    context: { json: (o: object, s: 401) => Response },
    reason: string,
  ) => {
    if (auditStore) {
      void recordAuditEvent(auditStore, {
        eventType: "delegation.refused",
        targetType: "delegation",
        initiator: DEPLOYMENT_INITIATOR,
        payload: { reason },
      }).catch(() => {});
    }
    return context.json(
      { error: "This endpoint is for deployment bots." },
      401,
    );
  };

  const autorizado = (request: Request): boolean => {
    if (!secreto) return false;
    const offered = request.headers.get("authorization");
    return !!offered && sameToken(offered, `Bearer ${secreto}`);
  };

  const archivo = (id: string, ext: string) =>
    resolve(bandejaDir, `${id}.${ext}.json`);

  const leerJson = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  };

  // Descubrimiento A2A: qué sabe hacer este extremo, sin credencial.
  routes.get("/.well-known/agent-card.json", (context) => {
    const origin = new URL(context.req.url).origin;
    return context.json({
      name: "openbot-delegaciones",
      description:
        "Bandeja bot-a-bot del despliegue OpenBot local: acepta tareas de otros bots sin pasar por el chat y devuelve el resultado por polling.",
      url: origin,
      version: "1.0.0",
      protocolVersion: "0.3",
      capabilities: { streaming: false, pushNotifications: false },
      skills: [
        {
          id: "delegar-tarea",
          name: "Delegar tarea",
          description:
            "Deja una tarea en la bandeja (POST /api/delegaciones) y consulta su estado (GET /api/delegaciones/:id).",
          tags: ["delegacion", "a2a-lite", "bandeja"],
        },
      ],
    });
  });

  // Aceptar una tarea: la escribe en la bandeja y responde 202.
  routes.post("/api/delegaciones", async (context) => {
    if (!autorizado(context.req.raw)) return refused(context, "mismatch");
    const body = (await context.req.json().catch(() => null)) as {
      id?: unknown;
      de?: unknown;
      para?: unknown;
      tarea?: unknown;
      dir?: unknown;
      sesion?: unknown;
      destino?: unknown;
    } | null;
    const id =
      typeof body?.id === "string" && body.id.trim()
        ? body.id.trim()
        : `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    if (!ID_RE.test(id)) {
      return context.json(
        { error: "id debe calzar ^[A-Za-z0-9_-]{1,64}$." },
        400,
      );
    }
    const para = typeof body?.para === "string" ? body.para.trim() : "";
    const tarea = typeof body?.tarea === "string" ? body.tarea.trim() : "";
    if (!para) return context.json({ error: "para es requerido." }, 400);
    if (!tarea || tarea.length > TAREA_MAX) {
      return context.json(
        { error: `tarea es requerida (1-${TAREA_MAX} caracteres).` },
        400,
      );
    }
    // Hilo opcional: carpeta de trabajo dentro de Base/ y sesión a continuar.
    const baseDir = resolve(bandejaDir, "..", "..");
    const dirPed = typeof body?.dir === "string" ? body.dir.trim() : "";
    if (dirPed) {
      const res = resolve(baseDir, dirPed);
      let esDir = false;
      try {
        esDir = statSync(res).isDirectory();
      } catch {}
      if (res !== baseDir && !res.startsWith(baseDir + sep)) {
        return context.json({ error: "dir debe estar dentro de Base/." }, 400);
      }
      if (!esDir) return context.json({ error: "dir no existe." }, 400);
    }
    const sesionPed =
      typeof body?.sesion === "string" ? body.sesion.trim() : "";
    if (sesionPed && !/^ses_[A-Za-z0-9]+$/.test(sesionPed)) {
      return context.json({ error: "sesion debe ser un id ses_*." }, 400);
    }
    const destinoPed =
      typeof body?.destino === "string" ? body.destino.trim() : "";
    if (destinoPed && !/^[A-Za-z0-9_-]{1,64}$/.test(destinoPed)) {
      return context.json(
        { error: "destino inválido (1-64: letras, números, _-)." },
        400,
      );
    }
    // Deduplicación: un id ya visto (en cualquier estado) no se acepta dos veces.
    if (
      existsSync(archivo(id, "tarea")) ||
      existsSync(archivo(id, "en_proceso")) ||
      existsSync(archivo(id, "resultado"))
    ) {
      return context.json({ error: "Ese id ya existe en la bandeja." }, 409);
    }
    try {
      mkdirSync(bandejaDir, { recursive: true });
    } catch {
      return context.json({ error: "No se pudo abrir la bandeja." }, 500);
    }
    const de =
      typeof body?.de === "string" && body.de.trim()
        ? body.de.trim()
        : "externo";
    const doc = {
      id,
      de,
      para,
      tarea,
      ...(dirPed ? { dir: dirPed } : {}),
      ...(sesionPed ? { sesion: sesionPed } : {}),
      ...(destinoPed ? { destino: destinoPed } : {}),
      creada: new Date().toISOString(),
      estado: "pendiente",
    };
    try {
      writeFileSync(archivo(id, "tarea"), JSON.stringify(doc, null, 2));
    } catch {
      return context.json({ error: "No se pudo escribir la tarea." }, 500);
    }
    // Push al suscriptor del `para` (bots que atienden eventos, ej. grokbot).
    empujar(bandejaDir, para, "tarea", {
      id,
      de,
      tarea,
      ...(dirPed ? { dir: dirPed } : {}),
      ...(sesionPed ? { sesion: sesionPed } : {}),
      ...(destinoPed ? { destino: destinoPed } : {}),
    });
    if (auditStore) {
      void recordAuditEvent(auditStore, {
        eventType: "delegation.accepted",
        targetType: "delegation",
        targetId: id,
        initiator: DEPLOYMENT_INITIATOR,
        payload: { para },
      }).catch(() => {});
    }
    return context.json({ id, estado: "pendiente" }, 202);
  });

  // Consultar una tarea: pendiente, en_proceso o el resultado final.
  routes.get("/api/delegaciones/:id", (context) => {
    if (!autorizado(context.req.raw)) return refused(context, "mismatch");
    const id = context.req.param("id");
    if (!ID_RE.test(id)) return context.json({ error: "id inválido." }, 400);
    const resultado = leerJson(archivo(id, "resultado"));
    if (resultado && typeof resultado === "object")
      return context.json(resultado);
    if (existsSync(archivo(id, "en_proceso")))
      return context.json({ id, estado: "en_proceso" });
    if (existsSync(archivo(id, "tarea")))
      return context.json({ id, estado: "pendiente" });
    return context.json({ error: "No existe esa delegación." }, 404);
  });

  // Entregar un resultado: el ejecutor remoto cierra la tarea sin tocar archivos.
  routes.post("/api/delegaciones/:id/resultado", async (context) => {
    if (!autorizado(context.req.raw)) return refused(context, "mismatch");
    const id = context.req.param("id");
    if (!ID_RE.test(id)) return context.json({ error: "id inválido." }, 400);
    const body = (await context.req.json().catch(() => null)) as {
      estado?: unknown;
      resumen?: unknown;
      sesion?: unknown;
    } | null;
    const estado = body?.estado === "error" ? "error" : "listo";
    const resumen =
      typeof body?.resumen === "string" ? body.resumen.trim() : "";
    if (!resumen || resumen.length > 8000) {
      return context.json(
        { error: "resumen es requerido (1-8000 caracteres)." },
        400,
      );
    }
    const sesion =
      typeof body?.sesion === "string" &&
      /^ses_[A-Za-z0-9]+$/.test(body.sesion.trim())
        ? body.sesion.trim()
        : null;
    if (existsSync(archivo(id, "resultado"))) {
      return context.json({ error: "Esa delegación ya tiene resultado." }, 409);
    }
    if (
      !existsSync(archivo(id, "tarea")) &&
      !existsSync(archivo(id, "en_proceso"))
    ) {
      return context.json({ error: "No existe esa delegación." }, 404);
    }
    try {
      const previaT = leerJson(archivo(id, "tarea")) as {
        de?: unknown;
        destino?: unknown;
      } | null;
      const previaP = leerJson(archivo(id, "en_proceso")) as {
        de?: unknown;
        destino?: unknown;
      } | null;
      const dePrev =
        (typeof previaT?.de === "string" && previaT.de.trim()) ||
        (typeof previaP?.de === "string" && previaP.de.trim()) ||
        "externo";
      const destinoPrev =
        (typeof previaT?.destino === "string" && previaT.destino.trim()) ||
        (typeof previaP?.destino === "string" && previaP.destino.trim()) ||
        null;
      writeFileSync(
        archivo(id, "resultado"),
        JSON.stringify(
          {
            id,
            estado,
            resumen,
            sesion,
            ...(destinoPrev ? { destino: destinoPrev } : {}),
            terminada: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      try {
        rmSync(archivo(id, "en_proceso"));
      } catch {}
      try {
        rmSync(archivo(id, "tarea"));
      } catch {}
      // Push al suscriptor del `de` (quien pidió, si atiende eventos).
      empujar(bandejaDir, dePrev, "resultado", { id, estado, resumen, sesion });
    } catch {
      return context.json({ error: "No se pudo escribir el resultado." }, 500);
    }
    if (auditStore) {
      void recordAuditEvent(auditStore, {
        eventType: "delegation.accepted",
        targetType: "delegation",
        targetId: id,
        initiator: DEPLOYMENT_INITIATOR,
        payload: { resultado: estado },
      }).catch(() => {});
    }
    return context.json({ id, estado }, 200);
  });

  return routes;
}
