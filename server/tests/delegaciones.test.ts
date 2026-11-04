import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createDelegacionesRoutes } from "../src/delegaciones/routes";

const SECRETO = "secreto-de-prueba";

function app(bandejaDir: string) {
  return createDelegacionesRoutes({ workerSecret: SECRETO, bandejaDir });
}

function post(
  app_: ReturnType<typeof createDelegacionesRoutes>,
  body: unknown,
  secret?: string,
) {
  return app_.request("/api/delegaciones", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(
  app_: ReturnType<typeof createDelegacionesRoutes>,
  id: string,
  secret?: string,
) {
  return app_.request(`/api/delegaciones/${id}`, {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

describe("delegaciones bot-a-bot", () => {
  test("agent-card pública sin credencial", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    try {
      const res = await app(dir).request("/.well-known/agent-card.json");
      expect(res.status).toBe(200);
      const card = (await res.json()) as { name: string; skills: unknown[] };
      expect(card.name).toBe("openbot-delegaciones");
      expect(card.skills.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sin secreto o con secreto malo: 401", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    try {
      const a = app(dir);
      expect((await post(a, { para: "x", tarea: "y" })).status).toBe(401);
      expect((await post(a, { para: "x", tarea: "y" }, "otro")).status).toBe(
        401,
      );
      expect((await get(a, "abc", "otro")).status).toBe(401);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ciclo completo: aceptar, duplicado 409, polling por estados", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    try {
      const a = app(dir);
      const creada = await post(
        a,
        { id: "t1", de: "grokbot", para: "opencode", tarea: "haz X" },
        SECRETO,
      );
      expect(creada.status).toBe(202);
      expect(await creada.json()).toEqual({ id: "t1", estado: "pendiente" });

      const dup = await post(
        a,
        { id: "t1", para: "opencode", tarea: "otra" },
        SECRETO,
      );
      expect(dup.status).toBe(409);

      const mala = await post(
        a,
        { id: "t2", para: "opencode", tarea: "" },
        SECRETO,
      );
      expect(mala.status).toBe(400);

      const pendiente = await get(a, "t1", SECRETO);
      expect(await pendiente.json()).toEqual({ id: "t1", estado: "pendiente" });

      // El ejecutor reclama (rename atómico) y luego entrega el resultado.
      renameSync(join(dir, "t1.tarea.json"), join(dir, "t1.en_proceso.json"));
      const curso = await get(a, "t1", SECRETO);
      expect(await curso.json()).toEqual({ id: "t1", estado: "en_proceso" });

      writeFileSync(
        join(dir, "t1.resultado.json"),
        JSON.stringify({ id: "t1", estado: "listo", resumen: "hecho" }),
      );
      const fin = await get(a, "t1", SECRETO);
      expect(await fin.json()).toEqual({
        id: "t1",
        estado: "listo",
        resumen: "hecho",
      });

      expect((await get(a, "no-existe", SECRETO)).status).toBe(404);
      expect((await get(a, "mala id", SECRETO)).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dir fuera de Base y sesion mala: 400; buenas: 202", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    try {
      const a = app(dir);
      const fuera = await post(
        a,
        { id: "f1", para: "opencode", tarea: "x", dir: "../../otro" },
        SECRETO,
      );
      expect(fuera.status).toBe(400);
      const mala = await post(
        a,
        { id: "f2", para: "opencode", tarea: "x", sesion: "no-es-sesion" },
        SECRETO,
      );
      expect(mala.status).toBe(400);
      const buena = await post(
        a,
        {
          id: "f3",
          de: "orquestador",
          para: "opencode",
          tarea: "x",
          dir: ".",
          sesion: "ses_abc123",
        },
        SECRETO,
      );
      expect(buena.status).toBe(202);
      expect(await buena.json()).toEqual({ id: "f3", estado: "pendiente" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("entregar resultado por HTTP: 401, 404, 400, 200, 409", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    try {
      const a = app(dir);
      const entregar = (id: string, body: unknown, secret?: string) =>
        a.request(`/api/delegaciones/${id}/resultado`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify(body),
        });
      expect(
        (await entregar("x", { estado: "listo", resumen: "ok" })).status,
      ).toBe(401);
      expect(
        (await entregar("x", { estado: "listo", resumen: "ok" }, SECRETO))
          .status,
      ).toBe(404);
      await post(a, { id: "r1", para: "grokbot", tarea: "haz" }, SECRETO);
      expect(
        (await entregar("r1", { estado: "listo", resumen: "" }, SECRETO))
          .status,
      ).toBe(400);
      const ok = await entregar(
        "r1",
        { estado: "listo", resumen: "hecho", sesion: "ses_abc" },
        SECRETO,
      );
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ id: "r1", estado: "listo" });
      const fin = await get(a, "r1", SECRETO);
      expect(await fin.json()).toEqual({
        id: "r1",
        estado: "listo",
        resumen: "hecho",
        sesion: "ses_abc",
        terminada: expect.any(String),
      });
      expect(
        (await entregar("r1", { estado: "listo", resumen: "otra" }, SECRETO))
          .status,
      ).toBe(409);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("push de eventos al suscriptor: tarea y resultado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bandeja-"));
    const recibidos: unknown[] = [];
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        recibidos.push(await req.json().catch(() => null));
        return Response.json({ ok: true });
      },
    });
    try {
      const url = `http://127.0.0.1:${mock.port}/evento`;
      writeFileSync(
        join(dir, "suscriptores.json"),
        JSON.stringify({ mockbot: { url }, jefe: { url } }),
      );
      const a = app(dir);
      await post(
        a,
        { id: "p1", de: "jefe", para: "mockbot", tarea: "haz" },
        SECRETO,
      );
      await post(a, { id: "p3", para: "nadie", tarea: "x" }, SECRETO);
      for (let i = 0; i < 40 && recibidos.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(recibidos.length).toBe(1);
      expect(recibidos[0]).toEqual({
        evento: "tarea",
        para: "mockbot",
        id: "p1",
        de: "jefe",
        tarea: "haz",
      });
      renameSync(join(dir, "p1.tarea.json"), join(dir, "p1.en_proceso.json"));
      await a.request("/api/delegaciones/p1/resultado", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${SECRETO}`,
        },
        body: JSON.stringify({ estado: "listo", resumen: "hecho" }),
      });
      for (let i = 0; i < 40 && recibidos.length < 2; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(recibidos.length).toBe(2);
      expect(recibidos[1]).toEqual({
        evento: "resultado",
        para: "jefe",
        id: "p1",
        estado: "listo",
        resumen: "hecho",
        sesion: null,
      });
    } finally {
      mock.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
