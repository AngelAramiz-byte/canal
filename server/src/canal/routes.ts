import { Hono } from "hono";
import {
  crearLimite,
  extraerBearer,
  hashToken,
  igualSecreto,
  normalizarNombre,
  nuevoId,
  nuevoToken,
} from "./auth";
import {
  ArchivoStore,
  SupaStore,
  defaultBandejaDir,
  type Agente,
  type CanalStore,
} from "./store";

/** Auditoría mínima inyectable (el server real envuelve su audit trail). */
export type CanalAudit = (evento: {
  tipo: "registrado" | "enviada" | "cerrada";
  objetivo: string;
  extra: Record<string, unknown>;
}) => void;

/**
 * Canal bot-a-bot v1 (Render + Supabase, o local en archivos).
 *
 * Identidad: cada agente se registra UNA vez con el secreto de alta
 * (`CANAL_BOOTSTRAP`, en Render env + KeePass, nunca en chat/código) y recibe
 * `uuid + token`. Todo lo demás usa `Authorization: Bearer cb_...`; el `de`
 * siempre es el dueño del token (no se acepta suplantar).
 * Sin correo, sin UI operativa: curl + polling. La única página es la telaraña
 * de observación (`GET /telarana`, solo metadatos, sin contenido de tareas).
 */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAREA_MAX = 8000;

function ipDe(context: { req: { header: (n: string) => string | undefined } }) {
  const fwd = context.req.header("x-forwarded-for");
  return (fwd ? fwd.split(",")[0] : (context.req.header("x-real-ip") ?? "?"))
    .trim()
    .slice(0, 64);
}

const COLORES: Record<string, string> = {
  pendiente: "#f5a623",
  en_proceso: "#4aa8ff",
  listo: "#3ddc84",
  error: "#ff5c5c",
};

const TELARANA_HTML = [
  "<!doctype html><html lang='es'><head><meta charset='utf-8'>",
  "<meta name='viewport' content='width=device-width,initial-scale=1'>",
  "<title>Telara&ntilde;a del canal</title>",
  "<style>body{background:#0b0e14;color:#dfe6f3;font-family:system-ui,sans-serif;margin:0}",
  "header{padding:12px 16px;border-bottom:1px solid #1e2635;font-size:14px}",
  "#ley{padding:8px 16px;font-size:12px;color:#9aa7bd}",
  "svg{display:block;width:100%;height:78vh}#pie{padding:8px 16px;font-size:12px;color:#9aa7bd}</style></head><body>",
  "<header><b>Telara&ntilde;a del canal bot-a-bot</b> &middot; <span id='res'>…</span></header>",
  "<div id='ley'>pendiente &#9679; en proceso &#9679; listo &#9679; error &#9679; &middot; auto-refresca 5 s &middot; solo metadatos, sin contenido</div>",
  "<svg id='red' viewBox='0 0 800 600'></svg>",
  "<div id='pie'>—</div>",
  "<script>",
  "var COL={pendiente:'#f5a623',en_proceso:'#4aa8ff',listo:'#3ddc84',error:'#ff5c5c'};",
  "function dibujar(d){",
  "var svg=document.getElementById('red');svg.innerHTML='';",
  "var NS='http://www.w3.org/2000/svg';",
  "var cx=400,cy=300,R=200,n=d.nodos.length||1;",
  "var pos={};",
  "d.nodos.forEach(function(nd,i){",
  "var a=-Math.PI/2+i*2*Math.PI/n;",
  "pos[nd.nombre]={x:cx+R*Math.cos(a),y:cy+R*Math.sin(a)};});",
  "d.aristas.forEach(function(ar){",
  "var p1=pos[ar.de],p2=pos[ar.para];if(!p1||!p2)return;",
  "var mx=(p1.x+p2.x)/2,my=(p1.y+p2.y)/2;",
  "var dx=mx-cx,dy=my-cy,L=Math.sqrt(dx*dx+dy*dy)||1;",
  "var qx=mx+dx/L*40,qy=my+dy/L*40;",
  "var pa=document.createElementNS(NS,'path');",
  "pa.setAttribute('d','M'+p1.x+' '+p1.y+' Q'+qx+' '+qy+' '+p2.x+' '+p2.y);",
  "pa.setAttribute('fill','none');pa.setAttribute('stroke',COL[ar.estado]||'#888');",
  "pa.setAttribute('stroke-width','1.6');pa.setAttribute('opacity','0.75');",
  "pa.innerHTML='<title>'+ar.id+' · '+ar.estado+'</title>';svg.appendChild(pa);});",
  "d.nodos.forEach(function(nd){",
  "var p=pos[nd.nombre];",
  "var c=document.createElementNS(NS,'circle');",
  "c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r','16');",
  "c.setAttribute('fill','#141b29');c.setAttribute('stroke','#4aa8ff');c.setAttribute('stroke-width','2');",
  "c.innerHTML='<title>'+nd.nombre+(nd.descripcion?' — '+nd.descripcion:'')+'</title>';svg.appendChild(c);",
  "var t=document.createElementNS(NS,'text');",
  "t.setAttribute('x',p.x);t.setAttribute('y',p.y+34);t.setAttribute('text-anchor','middle');",
  "t.setAttribute('fill','#dfe6f3');t.setAttribute('font-size','12');t.textContent=nd.nombre;svg.appendChild(t);});",
  "var porEstado={};d.aristas.forEach(function(ar){porEstado[ar.estado]=(porEstado[ar.estado]||0)+1;});",
  "document.getElementById('res').textContent=d.nodos.length+' agentes · '+d.aristas.length+' hilos';",
  "document.getElementById('pie').textContent=new Date().toLocaleString()+' · '+JSON.stringify(porEstado);}",
  "async function tic(){try{var r=await fetch('/api/canal/telarana');dibujar(await r.json());}catch(e){}}",
  "tic();setInterval(tic,5000);",
  "</script></body></html>",
].join("\n");

export function createCanalRoutes(options: {
  bootstrap?: string;
  databaseUrl?: string;
  bandejaDir?: string;
  audit?: CanalAudit;
}) {
  const { audit } = options;
  const bootstrap = options.bootstrap?.trim() ? options.bootstrap.trim() : null;
  const store: CanalStore =
    options.databaseUrl?.trim() && !options.bandejaDir
      ? new SupaStore(options.databaseUrl.trim())
      : new ArchivoStore(options.bandejaDir ?? defaultBandejaDir());
  const modo = store instanceof SupaStore ? "supa" : "archivos";
  // Límites por instancia (una instancia = un mapa; en Render free hay una sola.
  // Si se escala a N instancias, mover a BD).
  const limiteRegistro = crearLimite(5, 60_000);
  const limiteApi = crearLimite(240, 60_000);
  const routes = new Hono();

  const auditar: CanalAudit = (evento) => {
    try {
      audit?.(evento);
    } catch {}
  };

  const agenteDe = async (
    request: Request,
  ): Promise<{ agente: Agente } | { res: Response }> => {
    const token = extraerBearer(request);
    if (!token || !limiteApi(`api:${token.slice(0, 12)}`))
      return {
        res: Response.json(
          { error: "This endpoint is for deployment bots." },
          { status: 401 },
        ),
      };
    const agente = await store.porTokenHash(hashToken(token)).catch(() => null);
    if (!agente)
      return {
        res: Response.json(
          { error: "This endpoint is for deployment bots." },
          { status: 401 },
        ),
      };
    return { agente };
  };

  // Salud rápida (warm-up y cron anti-sueño; no toca la BD).
  routes.get("/api/canal/salud", (context) =>
    context.json({ ok: true, modo, ahora: new Date().toISOString() }),
  );

  // Registro: una vez por agente, con el secreto de alta. Devuelve el token UNA vez.
  routes.post("/api/canal/agentes/registrar", async (context) => {
    if (!bootstrap)
      return context.json(
        { error: "Registro cerrado en este despliegue." },
        503,
      );
    if (!limiteRegistro(`reg:${ipDe(context)}`))
      return context.json(
        { error: "Demasiados intentos, espera un minuto." },
        429,
      );
    const body = (await context.req.json().catch(() => null)) as {
      nombre?: unknown;
      descripcion?: unknown;
      bootstrap?: unknown;
    } | null;
    if (
      typeof body?.bootstrap !== "string" ||
      !igualSecreto(body.bootstrap.trim(), bootstrap)
    )
      return context.json({ error: "No autorizado." }, 403);
    const nombre = normalizarNombre(body?.nombre);
    if (!nombre)
      return context.json(
        { error: "nombre inválido (1-32: minúsculas, números, _-)." },
        400,
      );
    if (await store.porNombre(nombre).catch(() => null))
      return context.json({ error: "Ese nombre ya está registrado." }, 409);
    const descripcion =
      typeof body?.descripcion === "string" && body.descripcion.trim()
        ? body.descripcion.trim().slice(0, 280)
        : undefined;
    const agente: Agente = {
      id: nuevoId(),
      nombre,
      ...(descripcion ? { descripcion } : {}),
      tokenHash: "",
      creada: new Date().toISOString(),
    };
    const token = nuevoToken();
    agente.tokenHash = hashToken(token);
    await store.registrar(agente);
    auditar({ tipo: "registrado", objetivo: agente.id, extra: { nombre } });
    return context.json(
      { id: agente.id, nombre, ...(descripcion ? { descripcion } : {}), token },
      201,
    );
  });

  routes.get("/api/canal/agentes/yo", async (context) => {
    const r = await agenteDe(context.req.raw);
    if ("res" in r) return r.res;
    return context.json({
      id: r.agente.id,
      nombre: r.agente.nombre,
      ...(r.agente.descripcion ? { descripcion: r.agente.descripcion } : {}),
      creada: r.agente.creada,
    });
  });

  // Enviar: el `de` siempre es el dueño del token (no se acepta suplantar).
  routes.post("/api/canal/tareas", async (context) => {
    const r = await agenteDe(context.req.raw);
    if ("res" in r) return r.res;
    const yo = r.agente;
    const body = (await context.req.json().catch(() => null)) as {
      para?: unknown;
      tarea?: unknown;
      dir?: unknown;
      sesion?: unknown;
      destino?: unknown;
    } | null;
    const paraRaw = typeof body?.para === "string" ? body.para.trim() : "";
    const tarea = typeof body?.tarea === "string" ? body.tarea.trim() : "";
    if (!tarea || tarea.length > TAREA_MAX)
      return context.json(
        { error: `tarea requerida (1-${TAREA_MAX} caracteres).` },
        400,
      );
    const dest =
      (await store.porId(paraRaw).catch(() => null)) ??
      (await store.porNombre(paraRaw.toLowerCase()).catch(() => null));
    if (!dest)
      return context.json({ error: "para no es un agente registrado." }, 404);
    if (dest.id === yo.id)
      return context.json(
        { error: "No te escribas a ti mismo; usa tu memoria." },
        400,
      );
    const dirPed = typeof body?.dir === "string" ? body.dir.trim() : "";
    if (dirPed && !/^[A-Za-z0-9_/-]{1,120}$/.test(dirPed))
      return context.json({ error: "dir inválido." }, 400);
    const sesionPed =
      typeof body?.sesion === "string" ? body.sesion.trim() : "";
    if (sesionPed && !/^ses_[A-Za-z0-9]+$/.test(sesionPed))
      return context.json({ error: "sesion debe ser un id ses_*." }, 400);
    const destinoPed =
      typeof body?.destino === "string" ? body.destino.trim() : "";
    if (destinoPed && !ID_RE.test(destinoPed))
      return context.json({ error: "destino inválido." }, 400);
    const id = `c-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
    const creada = new Date().toISOString();
    const ok = await store
      .crearTarea({
        id,
        de: yo.id,
        para: dest.id,
        tarea,
        ...(dirPed ? { dir: dirPed } : {}),
        ...(sesionPed ? { sesion: sesionPed } : {}),
        ...(destinoPed ? { destino: destinoPed } : {}),
        creada,
        estado: "pendiente",
        canal: "v1",
      })
      .catch(() => false);
    if (!ok)
      return context.json({ error: "No se pudo escribir la tarea." }, 500);
    auditar({ tipo: "enviada", objetivo: id, extra: { para: dest.nombre } });
    return context.json({ id, estado: "pendiente" }, 202);
  });

  // Mi bandeja: lo pendiente + en proceso + últimos resultados dirigidos a mí.
  routes.get("/api/canal/bandeja/mias", async (context) => {
    const r = await agenteDe(context.req.raw);
    if ("res" in r) return r.res;
    const tareas = await store
      .mias(r.agente.id, r.agente.nombre)
      .catch(() => []);
    const nombres = new Map<string, string>();
    for (const a of await store.listarAgentes().catch(() => []))
      nombres.set(a.id, a.nombre);
    return context.json({
      tareas: tareas.map((t) => ({
        id: t.id,
        de: nombres.get(t.de) ?? t.de,
        estado: t.estado,
        creada: t.creada,
        ...(t.estado === "listo" || t.estado === "error"
          ? {
              resumen: t.resumen ?? "",
              por: t.por ?? null,
              terminada: t.terminada ?? null,
            }
          : { tarea: (t.tarea ?? "").slice(0, 2000) }),
      })),
    });
  });

  // Consultar un hilo (solo si soy parte: lo envié o va para mí; si no, 404 igual).
  routes.get("/api/canal/tareas/:id", async (context) => {
    const r = await agenteDe(context.req.raw);
    if ("res" in r) return r.res;
    const id = context.req.param("id");
    if (!ID_RE.test(id) && !/^c-[a-z0-9-]+$/.test(id))
      return context.json({ error: "id inválido." }, 400);
    const hall = await store.leerTarea(id).catch(() => null);
    if (!hall || (hall.doc.de !== r.agente.id && hall.doc.para !== r.agente.id))
      return context.json({ error: "No existe esa delegación." }, 404);
    if (hall.fase === "pendiente" || hall.fase === "en_proceso")
      return context.json({ id, estado: hall.fase });
    return context.json(hall.doc);
  });

  // Cerrar: solo el destinatario puede cerrar lo que va para él; queda firmado `por`.
  routes.post("/api/canal/tareas/:id/resultado", async (context) => {
    const r = await agenteDe(context.req.raw);
    if ("res" in r) return r.res;
    const id = context.req.param("id");
    if (!ID_RE.test(id) && !/^c-[a-z0-9-]+$/.test(id))
      return context.json({ error: "id inválido." }, 400);
    const hall = await store.leerTarea(id).catch(() => null);
    if (!hall) return context.json({ error: "No existe esa delegación." }, 404);
    if (hall.doc.para !== r.agente.id && hall.doc.para !== r.agente.nombre)
      return context.json({ error: "No existe esa delegación." }, 403);
    const body = (await context.req.json().catch(() => null)) as {
      estado?: unknown;
      resumen?: unknown;
      sesion?: unknown;
    } | null;
    const estado = body?.estado === "error" ? "error" : "listo";
    const resumen =
      typeof body?.resumen === "string" ? body.resumen.trim() : "";
    if (!resumen || resumen.length > 8000)
      return context.json({ error: "resumen requerido (1-8000)." }, 400);
    const sesion =
      typeof body?.sesion === "string" &&
      /^ses_[A-Za-z0-9]+$/.test(body.sesion.trim())
        ? body.sesion.trim()
        : null;
    const fin = await store
      .cerrarTarea(id, { estado, resumen, sesion, por: r.agente.id })
      .catch(() => "no" as const);
    if (fin === "no")
      return context.json({ error: "No existe esa delegación." }, 404);
    if (fin === "ya")
      return context.json({ error: "Ya tiene resultado." }, 409);
    auditar({ tipo: "cerrada", objetivo: id, extra: { estado } });
    return context.json({ id, estado }, 200);
  });

  // Telaraña: solo metadatos (nombres, estados, tiempos). Sin contenido de tareas.
  routes.get("/api/canal/telarana", async (context) => {
    const t = await store.telarana().catch(() => ({ nodos: [], aristas: [] }));
    context.header("cache-control", "no-store");
    return context.json(t);
  });

  routes.get("/telarana", (context) => context.html(TELARANA_HTML));

  return routes;
}
