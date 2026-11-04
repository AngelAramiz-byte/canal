import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

/**
 * Padrón + bandeja del canal. Dos motores, misma forma:
 * - archivos (local/dev): `canal-agentes.json` + `<id>.tarea/.en_proceso/.resultado.json`
 * - Supabase Postgres (Render): tablas `canal_agentes` / `canal_tareas`
 *   (ver `recursos/sql-para-dueno/03_canal.sql`).
 * El motor se elige solo: con `CANAL_DATABASE_URL` va a Supa, sin ella a disco.
 */

export type Agente = {
  id: string;
  nombre: string;
  tokenHash: string;
  creada: string;
};

export type Fase = "pendiente" | "en_proceso" | "listo" | "error";

export type DocTarea = {
  id: string;
  de: string;
  para: string;
  tarea: string;
  dir?: string;
  sesion?: string;
  destino?: string;
  creada: string;
  estado: string;
  canal: "v1";
  resumen?: string;
  por?: string;
  terminada?: string;
};

export type NodoTelarana = { id: string; nombre: string };
export type AristaTelarana = {
  id: string;
  de: string;
  para: string;
  estado: Fase;
  ts: string;
};

export interface CanalStore {
  registrar(a: Agente): Promise<void>;
  porId(id: string): Promise<Agente | null>;
  porNombre(nombre: string): Promise<Agente | null>;
  porTokenHash(h: string): Promise<Agente | null>;
  listarAgentes(): Promise<Agente[]>;
  crearTarea(doc: DocTarea): Promise<boolean>;
  leerTarea(id: string): Promise<{ doc: DocTarea; fase: Fase } | null>;
  mias(agenteId: string, nombre: string): Promise<DocTarea[]>;
  cerrarTarea(
    id: string,
    res: { estado: "listo" | "error"; resumen: string; sesion: string | null; por: string },
  ): Promise<"ok" | "ya" | "no">;
  telarana(): Promise<{ nodos: NodoTelarana[]; aristas: AristaTelarana[] }>;
}

export function defaultBandejaDir(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return resolve(here, "..", "..", "..", "..", "bandeja");
}

function leerJson(path: string): DocTarea | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!d || typeof d !== "object") return null;
    return d as DocTarea;
  } catch {
    return null;
  }
}

function faseDe(ext: string, doc: DocTarea): Fase {
  if (ext === "resultado")
    return doc.estado === "error" ? "error" : "listo";
  return ext === "en_proceso" ? "en_proceso" : "pendiente";
}

/** Motor de archivos (local). Reusa los mismos `.json` de la bandeja. */
export class ArchivoStore implements CanalStore {
  private dir: string;
  constructor(bandejaDir?: string) {
    this.dir = bandejaDir ?? defaultBandejaDir();
  }
  private regPath() {
    return join(this.dir, "canal-agentes.json");
  }
  private leerReg(): Agente[] {
    try {
      const d = JSON.parse(readFileSync(this.regPath(), "utf8")) as unknown;
      return Array.isArray(d) ? (d as Agente[]) : [];
    } catch {
      return [];
    }
  }
  private guardarReg(list: Agente[]) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.regPath(), JSON.stringify(list, null, 2));
  }
  async registrar(a: Agente) {
    const list = this.leerReg();
    list.push(a);
    this.guardarReg(list);
  }
  async porId(id: string) {
    return this.leerReg().find((a) => a.id === id) ?? null;
  }
  async porNombre(nombre: string) {
    return this.leerReg().find((a) => a.nombre === nombre) ?? null;
  }
  async porTokenHash(h: string) {
    return this.leerReg().find((a) => a.tokenHash === h) ?? null;
  }
  async listarAgentes() {
    return this.leerReg();
  }
  private paths(id: string) {
    return {
      tarea: join(this.dir, `${id}.tarea.json`),
      proc: join(this.dir, `${id}.en_proceso.json`),
      res: join(this.dir, `${id}.resultado.json`),
    };
  }
  async crearTarea(doc: DocTarea) {
    const p = this.paths(doc.id);
    if (existsSync(p.tarea) || existsSync(p.proc) || existsSync(p.res))
      return false;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(p.tarea, JSON.stringify(doc, null, 2));
    return true;
  }
  async leerTarea(id: string) {
    const p = this.paths(id);
    for (const [ext, path] of [
      ["resultado", p.res],
      ["en_proceso", p.proc],
      ["tarea", p.tarea],
    ] as const) {
      const doc = leerJson(path);
      if (doc) return { doc, fase: faseDe(ext, doc) };
    }
    return null;
  }
  async mias(agenteId: string, nombre: string) {
    const out: DocTarea[] = [];
    let archivos: string[] = [];
    try {
      archivos = readdirSync(this.dir);
    } catch {
      return out;
    }
    for (const f of archivos) {
      if (f.startsWith("_") || f.startsWith(".")) continue;
      const m = /^(.+)\.(tarea|en_proceso|resultado)\.json$/.exec(f);
      if (!m) continue;
      const doc = leerJson(join(this.dir, f));
      if (!doc || typeof doc !== "object") continue;
      if (doc.para !== agenteId && doc.para !== nombre) continue;
      out.push({ ...doc, estado: faseDe(m[2], doc) });
    }
    out.sort((a, b) => (a.creada < b.creada ? 1 : -1));
    return out.slice(0, 50);
  }
  async cerrarTarea(
    id: string,
    res: { estado: "listo" | "error"; resumen: string; sesion: string | null; por: string },
  ) {
    const p = this.paths(id);
    if (existsSync(p.res)) return "ya" as const;
    const base = leerJson(p.tarea) ?? leerJson(p.proc);
    if (!base) return "no" as const;
    const prev = base as { destino?: unknown; de?: unknown; para?: unknown };
    writeFileSync(
      p.res,
      JSON.stringify(
        {
          id,
          de: typeof prev.de === "string" ? prev.de : null,
          para: typeof prev.para === "string" ? prev.para : null,
          estado: res.estado,
          resumen: res.resumen,
          sesion: res.sesion,
          por: res.por,
          ...(typeof prev.destino === "string" && prev.destino
            ? { destino: prev.destino }
            : {}),
          terminada: new Date().toISOString(),
          canal: "v1",
        },
        null,
        2,
      ),
    );
    try {
      rmSync(p.proc);
    } catch {}
    try {
      rmSync(p.tarea);
    } catch {}
    return "ok" as const;
  }
  async telarana() {
    const nombres = new Map<string, string>();
    for (const a of this.leerReg()) nombres.set(a.id, a.nombre);
    const nom = (id: string) => nombres.get(id) ?? id;
    const aristas: AristaTelarana[] = [];
    let archivos: string[] = [];
    try {
      archivos = readdirSync(this.dir);
    } catch {
      archivos = [];
    }
    let n = 0;
    for (const f of archivos) {
      if (n >= 400) break;
      if (f.startsWith("_") || f.startsWith(".")) continue;
      const m = /^(.+)\.(tarea|en_proceso|resultado)\.json$/.exec(f);
      if (!m) continue;
      const doc = leerJson(join(this.dir, f));
      if (!doc || !doc.id || !doc.de || !doc.para) continue;
      n += 1;
      aristas.push({
        id: doc.id,
        de: nom(doc.de),
        para: nom(doc.para),
        estado: faseDe(m[2], doc),
        ts: doc.terminada ?? doc.creada ?? "",
      });
    }
    const vistos = new Map<string, string>();
    for (const a of this.leerReg()) vistos.set(a.nombre, a.id);
    for (const ar of aristas) {
      if (!vistos.has(ar.de)) vistos.set(ar.de, ar.de);
      if (!vistos.has(ar.para)) vistos.set(ar.para, ar.para);
    }
    const nodos: NodoTelarana[] = [...vistos.entries()].map(([nombre, id]) => ({
      id,
      nombre,
    }));
    aristas.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return { nodos, aristas: aristas.slice(0, 200) };
  }
}

/** Motor Supabase Postgres (Render). Conexión perezosa: no toca la BD al arrancar. */
export class SupaStore implements CanalStore {
  private db: ReturnType<typeof postgres> | null = null;
  constructor(private url: string) {}
  private con() {
    if (!this.db) {
      this.db = postgres(this.url, {
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
        prepare: false,
      });
    }
    return this.db;
  }
  async registrar(a: Agente) {
    const sql = this.con();
    await sql`insert into canal_agentes (id, nombre, token_hash, creada)
      values (${a.id}, ${a.nombre}, ${a.tokenHash}, ${a.creada})`;
  }
  async porId(id: string) {
    const sql = this.con();
    const rows = await sql`select id, nombre, token_hash as "tokenHash", creada
      from canal_agentes where id = ${id} limit 1`;
    return (rows[0] as Agente | undefined) ?? null;
  }
  async porNombre(nombre: string) {
    const sql = this.con();
    const rows = await sql`select id, nombre, token_hash as "tokenHash", creada
      from canal_agentes where nombre = ${nombre} limit 1`;
    return (rows[0] as Agente | undefined) ?? null;
  }
  async porTokenHash(h: string) {
    const sql = this.con();
    const rows = await sql`select id, nombre, token_hash as "tokenHash", creada
      from canal_agentes where token_hash = ${h} limit 1`;
    return (rows[0] as Agente | undefined) ?? null;
  }
  async listarAgentes() {
    const sql = this.con();
    const rows = await sql`select id, nombre, token_hash as "tokenHash", creada
      from canal_agentes order by creada asc limit 200`;
    return rows as unknown as Agente[];
  }
  async crearTarea(doc: DocTarea) {
    const sql = this.con();
    try {
      await sql`insert into canal_tareas (id, de, para, tarea, dir, sesion, destino, estado, creada)
        values (${doc.id}, ${doc.de}, ${doc.para}, ${doc.tarea},
          ${doc.dir ?? null}, ${doc.sesion ?? null}, ${doc.destino ?? null},
          'pendiente', ${doc.creada})`;
      return true;
    } catch (e) {
      if (String((e as Error)?.message ?? e).includes("duplicate")) return false;
      throw e;
    }
  }
  async leerTarea(id: string) {
    const sql = this.con();
    const rows = await sql`select id, de, para, tarea, dir, sesion, destino, estado,
        resumen, por, creada, terminada from canal_tareas where id = ${id} limit 1`;
    const r = rows[0] as unknown as DocTarea | undefined;
    if (!r) return null;
    return { doc: { ...r, canal: "v1" as const }, fase: r.estado as Fase };
  }
  async mias(agenteId: string, nombre: string) {
    const sql = this.con();
    const rows = await sql`select id, de, para, tarea, dir, sesion, destino, estado,
        resumen, por, creada, terminada from canal_tareas
      where para = ${agenteId} or para::text = ${nombre}
      order by creada desc limit 50`;
    return (rows as unknown as DocTarea[]).map((r) => ({
      ...r,
      canal: "v1" as const,
    }));
  }
  async cerrarTarea(
    id: string,
    res: { estado: "listo" | "error"; resumen: string; sesion: string | null; por: string },
  ) {
    const sql = this.con();
    const actual =
      await sql`select estado from canal_tareas where id = ${id} limit 1`;
    if (!actual[0]) return "no" as const;
    if ((actual[0] as { estado: string }).estado !== "pendiente") return "ya" as const;
    await sql`update canal_tareas set estado = ${res.estado}, resumen = ${res.resumen},
        sesion = ${res.sesion}, por = ${res.por}, terminada = now() where id = ${id}`;
    return "ok" as const;
  }
  async telarana() {
    const sql = this.con();
    const agentes = (await sql`select id, nombre from canal_agentes limit 200`) as unknown as {
      id: string;
      nombre: string;
    }[];
    const nombres = new Map(agentes.map((a) => [a.id, a.nombre]));
    const nom = (id: string) => nombres.get(id) ?? id;
    const tareas = (await sql`select t.id, d.nombre as de, p.nombre as para, t.estado,
        t.terminada, t.creada from canal_tareas t
      left join canal_agentes d on d.id = t.de
      left join canal_agentes p on p.id = t.para
      order by t.creada desc limit 200`) as unknown as {
      id: string;
      de: string | null;
      para: string | null;
      estado: Fase;
      terminada: string | null;
      creada: string;
    }[];
    const vistos = new Map<string, string>(agentes.map((a) => [a.nombre, a.id]));
    const aristas: AristaTelarana[] = tareas.map((t) => {
      const de = t.de ?? "?";
      const para = t.para ?? "?";
      if (!vistos.has(de)) vistos.set(de, de);
      if (!vistos.has(para)) vistos.set(para, para);
      return {
        id: t.id,
        de,
        para,
        estado: t.estado,
        ts: t.terminada ?? t.creada,
      };
    });
    void nom;
    return {
      nodos: [...vistos.entries()].map(([nombre, id]) => ({ id, nombre })),
      aristas,
    };
  }
}
