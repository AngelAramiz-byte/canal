import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createCanalRoutes } from "../src/canal/routes";

const BOOT = "alta-de-prueba";

function app(bandejaDir: string, bootstrap: string | null = BOOT) {
  return createCanalRoutes({ bootstrap: bootstrap ?? undefined, bandejaDir });
}

function req(
  app_: ReturnType<typeof createCanalRoutes>,
  metodo: string,
  ruta: string,
  cuerpo?: unknown,
  token?: string,
) {
  return app_.request(ruta, {
    method: metodo,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
}

async function registrar(
  app_: ReturnType<typeof createCanalRoutes>,
  nombre: string,
  bootstrap: string = BOOT,
) {
  const res = await req(app_, "POST", "/api/canal/agentes/registrar", {
    nombre,
    bootstrap,
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, string>,
  };
}

describe("canal v1: identidad por agente", () => {
  test("registro: bootstrap malo 403, nombre malo 400, duplicado 409", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      expect((await registrar(a, "grokbot", "mal")).status).toBe(403);
      expect((await registrar(a, "MAL NOMBRE")).status).toBe(400);
      const ok = await registrar(a, "grokbot");
      expect(ok.status).toBe(201);
      expect(ok.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(ok.body.token.startsWith("cb_")).toBe(true);
      expect((await registrar(a, "grokbot")).status).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sin bootstrap configurado: registro cerrado 503", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir, null);
      expect((await registrar(a, "x")).status).toBe(503);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("descripcion opcional: se guarda y aparece en yo y telaraña", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const res = await req(a, "POST", "/api/canal/agentes/registrar", {
        nombre: "grokbot",
        descripcion: "Responde con texto breve por el canal",
        bootstrap: BOOT,
      });
      expect(res.status).toBe(201);
      const reg = (await res.json()) as Record<string, string>;
      expect(reg.descripcion).toBe("Responde con texto breve por el canal");
      const yo = (await (
        await req(a, "GET", "/api/canal/agentes/yo", undefined, reg.token)
      ).json()) as Record<string, string>;
      expect(yo.descripcion).toBe("Responde con texto breve por el canal");
      await req(
        a,
        "POST",
        "/api/canal/tareas",
        { para: "grokbot", tarea: "hola" },
        (
          (await (
            await req(a, "POST", "/api/canal/agentes/registrar", {
              nombre: "opencode",
              bootstrap: BOOT,
            })
          ).json()) as { token: string }
        ).token,
      );
      const tela = (await (await a.request("/api/canal/telarana")).json()) as {
        nodos: { nombre: string; descripcion?: string }[];
      };
      const g = tela.nodos.find((n) => n.nombre === "grokbot");
      expect(g?.descripcion).toBe("Responde con texto breve por el canal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("clavePublica age: válida se guarda, mala se rechaza 400", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    const BUENA = `age1${"q".repeat(58)}`;
    try {
      const a = app(dir);
      expect(
        (
          await req(a, "POST", "/api/canal/agentes/registrar", {
            nombre: "x",
            clavePublica: "no-age",
            bootstrap: BOOT,
          })
        ).status,
      ).toBe(400);
      const ok = await req(a, "POST", "/api/canal/agentes/registrar", {
        nombre: "grokbot",
        clavePublica: BUENA,
        bootstrap: BOOT,
      });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as Record<string, string>).clavePublica).toBe(
        BUENA,
      );
      const tela = (await (await a.request("/api/canal/telarana")).json()) as {
        nodos: { nombre: string; clavePublica?: string }[];
      };
      expect(tela.nodos.find((n) => n.nombre === "grokbot")?.clavePublica).toBe(
        BUENA,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rotar: token nuevo sirve, viejo muere, id se conserva", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      const rot = await req(
        a,
        "POST",
        "/api/canal/agentes/rotar",
        {},
        g.body.token,
      );
      expect(rot.status).toBe(200);
      const nuevo = (await rot.json()) as { id: string; token: string };
      expect(nuevo.id).toBe(g.body.id);
      expect(nuevo.token.startsWith("cb_")).toBe(true);
      expect(nuevo.token).not.toBe(g.body.token);
      // Viejo muerto:
      expect(
        (await req(a, "GET", "/api/canal/agentes/yo", undefined, g.body.token))
          .status,
      ).toBe(401);
      // Nuevo vive:
      const yo = await req(
        a,
        "GET",
        "/api/canal/agentes/yo",
        undefined,
        nuevo.token,
      );
      expect(yo.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("papelera: archivar saca de mias, ver muestra fase, cerrar 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      const o = await registrar(a, "opencode");
      await req(a, "POST", "/api/canal/tareas", { para: "opencode", tarea: "x" }, g.body.token);
      const mias0 = (await (
        await req(a, "GET", "/api/canal/bandeja/mias", undefined, o.body.token)
      ).json()) as { tareas: { id: string }[] };
      const id = mias0.tareas[0].id;
      const miron = await registrar(a, "miron");
      // Un tercero (ni de ni para) no puede archivar: 403.
      expect(
        (
          await req(a, "POST", `/api/canal/tareas/${id}/papelera`, {}, miron.body.token)
        ).status,
      ).toBe(403);
      const arch = await req(
        a, "POST", `/api/canal/tareas/${id}/papelera`, { motivo: "ruido" }, o.body.token,
      );
      expect(arch.status).toBe(200);
      expect(
        ((await (await req(a, "GET", "/api/canal/bandeja/mias", undefined, o.body.token)).json()) as {
          tareas: unknown[];
        }).tareas.length,
      ).toBe(0);
      const pap = (await (
        await req(a, "GET", "/api/canal/papelera", undefined, o.body.token)
      ).json()) as { tareas: { id: string }[] };
      expect(pap.tareas.map((t) => t.id)).toContain(id);
      const ver = await req(a, "GET", `/api/canal/tareas/${id}`, undefined, o.body.token);
      expect(((await ver.json()) as { fase?: string }).fase).toBe("papelera");
      expect(
        (
          await req(a, "POST", `/api/canal/tareas/${id}/resultado`, { resumen: "tarde" }, o.body.token)
        ).status,
      ).toBe(404);
      expect(
        (
          await req(a, "POST", `/api/canal/tareas/${id}/papelera`, {}, o.body.token)
        ).status,
      ).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("yo: sin token 401, con token 200", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      expect((await req(a, "GET", "/api/canal/agentes/yo")).status).toBe(401);
      expect(
        (await req(a, "GET", "/api/canal/agentes/yo", undefined, "cb_falso"))
          .status,
      ).toBe(401);
      const yo = await req(
        a,
        "GET",
        "/api/canal/agentes/yo",
        undefined,
        g.body.token,
      );
      expect(yo.status).toBe(200);
      expect(await yo.json()).toMatchObject({
        id: g.body.id,
        nombre: "grokbot",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enviar: de forzado al dueño del token, para debe existir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      const o = await registrar(a, "opencode");
      const fantasma = await req(
        a,
        "POST",
        "/api/canal/tareas",
        {
          para: "nadie",
          tarea: "hola",
        },
        g.body.token,
      );
      expect(fantasma.status).toBe(404);
      const yo = await req(
        a,
        "POST",
        "/api/canal/tareas",
        {
          para: "opencode",
          tarea: "hola",
          de: "suplantado",
        },
        g.body.token,
      );
      expect(yo.status).toBe(202);
      const id = ((await yo.json()) as { id: string }).id;
      const hilo = await req(
        a,
        "GET",
        `/api/canal/tareas/${id}`,
        undefined,
        g.body.token,
      );
      expect(hilo.status).toBe(200);
      // El detalle de un pendiente trae contenido (no solo {id,estado}).
      expect(((await hilo.json()) as { tarea?: string }).tarea).toBe("hola");
      // El tercero no es parte: 404 igual (sin oráculo).
      const ajeno = await req(
        a,
        "GET",
        `/api/canal/tareas/${id}`,
        undefined,
        (await registrar(a, "miron")).body.token,
      );
      expect(ajeno.status).toBe(404);
      void o;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bandeja propia aislada y cierre solo por destinatario", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      const o = await registrar(a, "opencode");
      await req(
        a,
        "POST",
        "/api/canal/tareas",
        { para: "opencode", tarea: "haz X" },
        g.body.token,
      );
      const miasG = await req(
        a,
        "GET",
        "/api/canal/bandeja/mias",
        undefined,
        g.body.token,
      );
      expect(
        ((await miasG.json()) as { tareas: unknown[] }).tareas.length,
      ).toBe(0);
      const miasO = await req(
        a,
        "GET",
        "/api/canal/bandeja/mias",
        undefined,
        o.body.token,
      );
      const lista = ((await miasO.json()) as { tareas: { id: string }[] })
        .tareas;
      expect(lista.length).toBe(1);
      const id = lista[0].id;
      // El remitente no puede cerrar lo que envió: 403.
      expect(
        (
          await req(
            a,
            "POST",
            `/api/canal/tareas/${id}/resultado`,
            { resumen: "yo" },
            g.body.token,
          )
        ).status,
      ).toBe(403);
      const cierra = await req(
        a,
        "POST",
        `/api/canal/tareas/${id}/resultado`,
        { resumen: "hecho", sesion: "ses_abc123" },
        o.body.token,
      );
      expect(cierra.status).toBe(200);
      expect(
        (
          await req(
            a,
            "POST",
            `/api/canal/tareas/${id}/resultado`,
            { resumen: "otra" },
            o.body.token,
          )
        ).status,
      ).toBe(409);
      const ver = await req(
        a,
        "GET",
        `/api/canal/tareas/${id}`,
        undefined,
        g.body.token,
      );
      const doc = (await ver.json()) as Record<string, unknown>;
      expect(doc).toMatchObject({ estado: "listo", sesion: "ses_abc123" });
      expect(typeof doc.por).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("telaraña: nodos y arista sin contenido", async () => {
    const dir = mkdtempSync(join(tmpdir(), "canal-"));
    try {
      const a = app(dir);
      const g = await registrar(a, "grokbot");
      await registrar(a, "opencode");
      await req(
        a,
        "POST",
        "/api/canal/tareas",
        { para: "opencode", tarea: "secreto" },
        g.body.token,
      );
      const res = await a.request("/api/canal/telarana");
      expect(res.status).toBe(200);
      const tela = (await res.json()) as {
        nodos: { nombre: string }[];
        aristas: { estado: string; tarea?: string }[];
      };
      expect(tela.nodos.map((n) => n.nombre).sort()).toEqual([
        "grokbot",
        "opencode",
      ]);
      expect(tela.aristas.length).toBe(1);
      expect(tela.aristas[0].estado).toBe("pendiente");
      expect(tela.aristas[0].tarea).toBeUndefined();
      expect((await a.request("/telarana")).status).toBe(200);
      expect((await a.request("/api/canal/salud")).status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
