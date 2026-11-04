/**
 * Puente Telegram ↔ OpenBot.
 *
 * Un script único (Bun) que convierte un chat de Telegram en un segundo teclado
 * de la app: recibe mensajes por long-polling (no requiere URL pública ni abrir
 * puertos), los escribe en el canal del Orquestador dentro de la app con un
 * Edge headless (Playwright, channel "msedge"/"chrome" del sistema), y devuelve
 * a Telegram cada respuesta nueva que aparece en el transcript.
 *
 * Multimodal v1:
 *  - texto  → al Orquestador tal cual.
 *  - voz    → whisper vía Groq (TRANSCRIPTION_* del .env) → texto → Orquestador.
 *  - imagen → aviso: el modelo gratuito actual no ve imágenes; se pide pegarla
 *             en la app (fase 2: adjuntarla al compositor).
 *
 * Uso:  bun bridge/telegram-bridge.ts   (o el lanzador openbot-telegram.cmd)
 * Config en .env: TELEGRAM_BOT_TOKEN (requerido), OPENBOT_URL, OPENBOT_AGENT.
 */

import { chromium, type Browser, type Page } from "playwright-core";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// --- Configuración (Bun carga el .env de la raíz del repo automáticamente) ---

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const OPENBOT_URL = process.env.OPENBOT_URL?.trim() || "http://localhost:3010";
const AGENT = process.env.OPENBOT_AGENT?.trim() || "orquestador";
const GROQ_KEY = process.env.TRANSCRIPTION_API_KEY?.trim() ?? "";
const GROQ_MODEL =
  process.env.TRANSCRIPTION_MODEL?.trim() || "whisper-large-v3-turbo";
/** Si se define, solo esos chat_id de Telegram pueden usar el puente. */
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const STATE_FILE = fileURLToPath(new URL("./state.json", import.meta.url));
/** Bandeja bot-a-bot (A2A-lite): tareas por archivo, sin pasar por el chat. */
const BANDEJA_DIR = fileURLToPath(new URL("../../bandeja", import.meta.url));
const LAB_DIR = fileURLToPath(
  new URL("../../../LaboratorioREA", import.meta.url),
);
const OPENCODE_BIN =
  process.env.OPENCODE_BIN?.trim() ||
  join(
    homedir(),
    ".bun",
    "install",
    "global",
    "node_modules",
    "@opencode",
    "cli",
    "bin",
    "opencode.exe",
  ); // binario real (el shim de .bun/bin no resuelve bajo procesos detached)
const BANDEJA_INTERVALO = 30_000;
const BANDEJA_TIMEOUT = 600_000;
/** Ventana de ejecución, hora de México. Vacío = 24/7. Ej: "09:00-18:00". */
const BANDEJA_HORARIO = process.env.BANDEJA_HORARIO?.trim() ?? "";
/** Días 1=lunes..7=domingo, ej: "1,2,3,4,5". Vacío = todos. */
const BANDEJA_DIAS = process.env.BANDEJA_DIAS?.trim() ?? "";
let bandejaOcupada = false;
let bandejaFueraAviso = false;

/** Hora local (America/Mexico_City): minutos del día y día 1=lunes..7=domingo. */
function horaLocal(): { min: number; dia: number } {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Mexico_City",
    hourCycle: "h23",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  const diaSem = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    get("weekday"),
  );
  return {
    min: parseInt(get("hour"), 10) * 60 + parseInt(get("minute"), 10),
    dia: diaSem <= 0 ? 7 : diaSem,
  };
}

function enHorario(): boolean {
  if (!BANDEJA_HORARIO && !BANDEJA_DIAS) return true;
  const { min, dia } = horaLocal();
  if (BANDEJA_DIAS) {
    const dias = BANDEJA_DIAS.split(",").map((d) => parseInt(d.trim(), 10));
    if (!dias.includes(dia)) return false;
  }
  const m = BANDEJA_HORARIO.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (m) {
    const ini = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    const fin = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
    if (ini <= fin ? min < ini || min >= fin : min < ini && min >= fin)
      return false;
  }
  return true;
}
const LOG = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

/** Página activa del canal. Viva siempre: openChannel la crea y las reaperturas la reemplazan. */
let currentPage: Page | null = null;

type State = {
  channelUrl?: string;
  chatId?: number;
  /**
   * Memoria del escucha de correos POR buzón (id: irs / gmail_allure-thenar):
   * ids ya vistos + si ya se sembró el baseline de ese buzón.
   */
  correosCuentas?: Record<string, { vistos: string[]; sembrado: boolean }>;
  /** Respuestas del bot ya retransmitidas por sesión: /ir solo reenvía lo pendiente. */
  vistos?: Record<string, number>;
  /** Firmas de textos ya retransmitidos por canal: nada visto se repite jamás. */
  vistosTextos?: Record<string, string[]>;
  /** Cola de OpenCode: la sesión que responde a /oc y su carpeta de proyecto. */
  ocSesion?: string;
  ocDir?: string;
  /** Plan de /poda armado y en espera de su /poda SÍ (expira a los 5 minutos). */
  podaPendiente?: { ids: string[]; quedan: number; cuando: number };
};
const state: State = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
  : {};
const saveState = () =>
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

// --- Telegram ---

async function tg(method: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => null)) as {
    ok: boolean;
    result?: any;
    description?: string;
    parameters?: { retry_after?: number };
  } | null;
  if (!json?.ok)
    throw new Error(`Telegram ${method}: ${json?.description ?? res.status}`);
  return json.result;
}

async function sendTelegram(
  chatId: number,
  text: string,
  teclado?: { inline_keyboard: [{ text: string; callback_data: string }][] },
): Promise<void> {
  // Telegram admite 4096 caracteres por mensaje; se parte en trozos.
  const chunks: string[] = [];
  for (let rest = text.trim(); rest.length > 0; ) {
    const cut = rest.slice(
      0,
      rest.length <= 4000 ? undefined : rest.lastIndexOf("\n", 4000),
    );
    chunks.push(cut || rest.slice(0, 4000));
    rest = rest.slice(chunks[chunks.length - 1].length).trimStart();
  }
  for (const chunk of chunks.length ? chunks : ["(respuesta vacía)"]) {
    for (let intento = 0; ; intento++) {
      try {
        try {
          // Markdown legacy de Telegram: *negrita*, _cursiva_, `mono`.
          // Si el texto trae asteriscos/underscores sueltos, Telegram lo
          // rechaza; el catch interno reenvía el mismo trozo en plano.
          await tg("sendMessage", {
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
            ...(teclado ? { reply_markup: teclado } : {}),
          });
        } catch (parseErr) {
          const pdesc = String(parseErr);
          if (!/parse|entiti/i.test(pdesc)) throw parseErr;
          LOG("markdown rechazado, relanzo plano:", pdesc.slice(0, 110));
          await tg("sendMessage", {
            chat_id: chatId,
            text: chunk,
            ...(teclado ? { reply_markup: teclado } : {}),
          });
        }
        break;
      } catch (err) {
        if (intento >= 3) throw err;
        LOG("reintentando envío:", String(err).slice(0, 140));
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

// --- OpenBot (Edge headless que maneja la app) ---

async function launchBrowser(): Promise<Browser> {
  for (const channel of ["msedge", "chrome"] as const) {
    try {
      const browser = await chromium.launch({ channel, headless: true });
      LOG(`navegador: ${channel} (headless)`);
      return browser;
    } catch {
      /* siguiente canal */
    }
  }
  LOG("sin Edge/Chrome del sistema; probando Chromium incluido de Playwright");
  return chromium.launch({ headless: true });
}

/** Crea el canal por API sin gastar modelo y guarda su URL. */
async function crearCanal(): Promise<string> {
  const res = await fetch(`${OPENBOT_URL}/api/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentIds: [AGENT] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`crear canal: ${res.status}`);
  const ch = (await res.json()) as { channel?: { id?: string } };
  const id = typeof ch?.channel?.id === "string" ? ch.channel.id : null;
  if (!id) throw new Error("crear canal: sin id");
  state.channelUrl = `${OPENBOT_URL}/channel/${id}`;
  saveState();
  return state.channelUrl;
}

async function openChannel(browser: Browser, destino?: string): Promise<Page> {
  const page = await browser.newPage();
  const ir = async (destino: string) => {
    await page.goto(destino, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForSelector(".prompt-area-editor", { timeout: 30_000 });
  };
  let abierto = false;
  const elegido = destino ?? state.channelUrl;
  if (elegido) {
    try {
      await ir(elegido);
      abierto = true;
    } catch {
      LOG("el canal no responde; creando uno nuevo");
    }
  }
  // Un canal real siempre: solo el canal creado tiene adjuntos y compositor completo.
  if (!abierto) await ir(await crearCanal());
  LOG("canal abierto:", page.url());
  return page;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sesión de OpenBot tal como la lista `GET /api/channels`. */
type SesionDeLista = {
  id: string;
  name: string | null;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string | null;
};

/**
 * Sesiones de OpenBot, directo de la API y ordenadas lo más reciente arriba.
 *
 * Esta lista es el registro de sesiones del deployment — la misma tela que la barra lateral de la
 * app — así que fijarse aquí y no en una historia local es no poder desalinearse: un canal creó
 * `POST /api/channels`, aparece aquí; uno que se borró, desaparece de aquí.
 */
async function listarSesiones(): Promise<SesionDeLista[]> {
  const res = await fetch(`${OPENBOT_URL}/api/channels`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`listar sesiones: ${res.status}`);
  const body = (await res.json()) as { channels?: SesionDeLista[] };
  return (body.channels ?? []).sort((a, b) =>
    String(b.lastMessageAt ?? "").localeCompare(String(a.lastMessageAt ?? "")),
  );
}

/**
 * Borrar una sesión por id: el mismo borrado suave que hace el botón de cerrar
 * de la app. 404 cuenta como bien (ya no estaba).
 */
async function borrarSesion(id: string): Promise<void> {
  const res = await fetch(`${OPENBOT_URL}/api/channels/${id}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`borrar sesión: ${res.status}`);
}

/**
 * Último mensaje del bot de una sesión, leído a vuelo.
 *
 * Abre la sesión en una página prestada (se cierra al terminar), recorre sus
 * filas de bot y devuelve el texto de la última. Sirve para la pregunta
 * "¿qué quedó en la otra conversación?" sin cambiar de sesión: un mensaje
 * prestado no toca la sesión activa ni su retransmisión.
 *
 * DEVUELVE `null` cuando la sesión no da texto (aquella respuesta que quedó a
 * medias — fila grabada sin contenido) — el que invoca escribe lo suyo en
 * vez de mandar un vacío a Telegram.
 */
async function ultimoDeSesion(
  browser: Browser,
  sesionId: string,
): Promise<string | null> {
  const page = await browser.newPage();
  try {
    await page.goto(`${OPENBOT_URL}/channel/${sesionId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForSelector(".prompt-area-editor", { timeout: 30_000 });
    const textos = await snapshotReplies(page);
    const ultimo = textos[textos.length - 1];
    return ultimo?.length ? ultimo : null;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Resumen corto de una sesion para Telegram: numero, nombre, fecha y ultimo mensaje.
 */

// --- Escucha de correos (Gmail vía la puerta MCP de Composio) ---

const COMPOSIO_KEY = process.env.COMPOSIO_API_KEY?.trim() ?? "";
const COMPOSIO_URL = "https://connect.composio.dev/mcp";
const INTERVALO_CORREOS = 3 * 60_000;
const MAX_CORREOS_POR_AVISO = 5;

/**
 * Cliente JSON-RPC mínimo contra la puerta MCP.
 *
 * La puerta contesta como `event-stream` o como JSON cruda según el día, así
 * que se prueban las dos formas; la sesión se toma del header si la puerta la
 * regala y el handshake (initialize + notification) va en cada arranque porque
 * una sesión de MCP no vive entre procesos.
 *
 * El estado del mailbox NO se toca: solo se lee (`is:unread`). Marcar leídos
 * desde un notificador sería borrarles de la bandeja lo que el aviso prometió.
 */
async function mcpCall(name: string, args: unknown): Promise<string> {
  let nid = 1;
  const single = async (body: {}) =>
    fetch(COMPOSIO_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${COMPOSIO_KEY}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  const parse = async (res: Response): Promise<any> => {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      const linea = text.split("\n").find((l) => l.startsWith("data:"));
      if (linea) {
        try {
          return JSON.parse(linea.slice(5).trim());
        } catch {
          /* sigue */
        }
      }
      return null;
    }
  };
  await parse(
    await single({
      jsonrpc: "2.0",
      id: nid++,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "telegram-bridge", version: "1.0" },
      },
    }),
  );
  await single({ jsonrpc: "2.0", method: "notifications/initialized" });
  const res = await parse(
    await single({
      jsonrpc: "2.0",
      id: nid++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  const out = (res?.result?.content ?? [])
    .map((c: any) => c.text ?? "")
    .join(" ");
  if (!out) throw new Error(`MCP ${name}: respuesta vacía`);
  return out;
}

type CorreoResumen = {
  id: string;
  de: string;
  asunto: string;
  cuando: string;
  vista: string;
};

/** Buzones escuchados: la llave `account` del MCP y la etiqueta del aviso. */
const CUENTAS_CORREO = [
  { account: "irs", etiqueta: "IRS Deméxico" },
  { account: "gmail_allure-thenar", etiqueta: "IRS Maquinados" },
];

/**
 * Ids de correos no leídos (solo ids: barato, sin cuerpo ni payloads que
 * offloaden). El campo `account` va JUNTO al tool_slug, no dentro de
 * arguments: sin él la puerta rechaza con "specify which to use".
 */
async function unreadIds(cuenta: string): Promise<string[]> {
  const out = (await mcpCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: [
      {
        tool_slug: "GMAIL_FETCH_EMAILS",
        account: cuenta,
        arguments: { query: "is:unread", verbose: false, ids_only: true },
      },
    ],
  })) as string;
  const parsed = JSON.parse(out);
  const data = parsed?.data ?? parsed?.data_preview ?? {};
  const results = data?.results ?? [];
  const first = results[0]?.response ?? {};
  const msgs =
    first.data?.messages ?? first.data_preview?.messages ?? data.messages ?? [];
  return msgs
    .map((m: any) => String(m.messageId ?? m.id ?? ""))
    .filter(Boolean)
    .slice(0, 20);
}

/** De / a / asunto / vista del cuerpo de cada id, una sola llamada con todos. */
async function hydrateCorreos(
  ids: string[],
  cuenta: string,
): Promise<CorreoResumen[]> {
  if (!ids.length) return [];
  const out = (await mcpCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: ids.map((id) => ({
      tool_slug: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      account: cuenta,
      arguments: { message_id: id, user_id: "me", format: "full" },
    })),
  })) as string;
  const parsed = JSON.parse(out);
  const results = parsed?.data?.results ?? [];
  return results
    .map((r: any) => {
      const data = r?.response?.data ?? r?.response?.data_preview ?? {};
      // Cuerpo plano si lo hay: colapsar blancos y, si vino HTML sin texto,
      // quitar etiquetas para que no ruede basura al Telegram.
      const vistaBruta = String(data.messageText ?? "")
        .replace(/<[^>]{1,120}>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        id: String(data.messageId ?? data.id ?? r?.tool_slug ?? ""),
        de: String(data.sender ?? data.senderEmail ?? ""),
        asunto: String(data.subject ?? "(sin asunto)"),
        cuando: String(data.messageTimestamp ?? ""),
        vista: vistaBruta.slice(0, 180) || "(sin texto plano en el cuerpo)",
      };
    })
    .filter((c: CorreoResumen) => c.id || c.de || c.asunto);
}

let corriendoCorreos = false;

/**
 * Un latido del escucha: lista los no leídos de CADA buzón, compara contra lo
 * ya visto y avisa solo lo NUEVO, con etiqueta de buzón. La primera vuelta de
 * cada buzón siembra su memoria sin avisar (avisar los no leídos anclados de
 * un buzón recién conectado sería una inundación, no un aviso). Falla en
 * silencio logueado: un error de esta sonda no debe tumbar el puente ni
 * despertar avisos falsos.
 */
async function tickCorreos(): Promise<void> {
  if (corriendoCorreos || !state.chatId) return;
  corriendoCorreos = true;
  try {
    // Adjuntar el objeto memorias AL estado SIEMPRE: un objeto local suelto
    // se serializa fuera y el sembrado se repetiría cada 3 min sin persistir.
    state.correosCuentas ??= {};
    const memorias = state.correosCuentas;
    for (const { account, etiqueta } of CUENTAS_CORREO) {
      const memoria = memorias[account] ?? {
        vistos: new Array<string>(),
        sembrado: false,
      };
      const ids = await unreadIds(account).catch(() => [] as string[]);
      const vistos = new Set(memoria.vistos);
      if (!memoria.sembrado) {
        for (const id of ids) vistos.add(id);
        memoria.vistos = [...vistos].slice(-500);
        memoria.sembrado = true;
        memorias[account] = memoria;
        saveState();
        LOG(`correos ${etiqueta}: memoria sembrada con`, memoria.vistos.length);
        continue;
      }
      const nuevos = ids.filter((id) => !vistos.has(id));
      if (!nuevos.length) continue;
      const detalle = await hydrateCorreos(
        nuevos.slice(0, MAX_CORREOS_POR_AVISO),
        account,
      );
      for (const c of detalle.slice(0, MAX_CORREOS_POR_AVISO)) {
        await sendTelegram(
          state.chatId!,
          `📧 *Correo no leído — ${etiqueta}*\nDe: ${c.de || "(remitente oculto)"}\nAsunto: ${c.asunto}\n\n> ${c.vista}`,
        );
        // Cada aviso también queda en el diario de la bóveda: una entrada por
        // correo, para que el rastro del buzón sea legible en Obsidian.
        registrar(
          `Correo entrante — ${etiqueta}`,
          `${c.de || "(remitente oculto)"} · ${c.asunto}`,
        );
      }
      if (nuevos.length > MAX_CORREOS_POR_AVISO) {
        await sendTelegram(
          state.chatId!,
          `📧 …y ${nuevos.length - MAX_CORREOS_POR_AVISO} correos no leídos más en ${etiqueta}.`,
        );
      }
      for (const id of nuevos) vistos.add(id);
      memoria.vistos = [...vistos].slice(-500);
      memorias[account] = memoria;
      saveState();
      LOG(
        `correos ${etiqueta}: avisados`,
        detalle.length,
        "de",
        nuevos.length,
        "nuevos",
      );
    }
  } catch (err) {
    LOG("correos (escucha):", String(err).slice(0, 160));
  } finally {
    corriendoCorreos = false;
  }
}
function resumenSesion(s: SesionDeLista, n: number): string {
  const cuando = String(s.lastMessageAt ?? s.createdAt ?? "")
    .slice(0, 16)
    .replace("T", " ");
  const ultimo = String(s.lastMessage ?? "")
    .replace(/\s+/g, " ")
    .slice(0, 60);
  const nombre = s.name?.trim() || "Sesión sin nombre";
  return `${n}. ${nombre}${cuando ? ` · ${cuando}` : ""}\n    ${ultimo || "(sin mensajes)"}`;
}

/**
 * ¿Hay un turno corriendo? Mientras dura un run, el compositor enseña su botón
 * de detener. Escribir en ese estado aparca el mensaje, y los aparcados se
 * quedan huérfanos: por eso aquí se hace cola ANTES de escribir.
 */
async function composerBusy(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean(document.querySelector('[data-testid="composer-stop"]')),
  );
}

/**
 * Cola de entrega: espera a que el canal quede libre antes de escribir. Si la
 * espera pasa de 8s, avisa una vez en Telegram que el mensaje quedó en cola.
 * Devuelve false si la página murió o la espera venció (10 min).
 */
async function waitForFree(chatId: number): Promise<boolean> {
  const t0 = Date.now();
  let avisado = false;
  while (Date.now() - t0 < 10 * 60_000) {
    const page = currentPage;
    if (!page) return false;
    try {
      if (!(await composerBusy(page))) return true;
      if (!avisado && Date.now() - t0 > 8000) {
        avisado = true;
        LOG("cola: canal ocupado, el mensaje espera…");
        await sendTelegram(
          chatId,
          "⏳ El equipo está terminando una tarea: tu mensaje quedó en cola y se entregará en cuanto termine.",
        );
      }
    } catch {
      return false;
    }
    await sleep(2000);
  }
  return false;
}

/**
 * Adjunta un archivo al compositor y lo envía, verificando que salió: mientras
 * el archivo se prepara el Enter no siempre envía, así que reintenta hasta 3
 * veces y falla en voz alta si el chip del archivo sigue pendiente.
 */
async function adjuntarYEnviar(
  page: Page,
  nombre: string,
  mime: string,
  buffer: Buffer,
  caption: string | null,
): Promise<void> {
  await page.setInputFiles(".prompt-area input[type=file]", {
    name: nombre,
    mimeType: mime,
    buffer,
  });
  if (caption?.trim()) {
    await page.evaluate((t) => {
      const editor = document.querySelector<HTMLElement>(".prompt-area-editor");
      editor?.focus();
      document.execCommand("insertText", false, t.trim());
    }, caption);
  }
  const chip = nombre.split("/").pop() ?? nombre;
  for (let intento = 0; intento < 3; intento++) {
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLElement>(".prompt-area-editor");
      editor?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          bubbles: true,
        }),
      );
    });
    await sleep(2500);
    const siguePendiente = await page.evaluate(
      (n) =>
        Boolean(document.querySelector(".prompt-area")?.innerText?.includes(n)),
      chip,
    );
    if (!siguePendiente) return;
  }
  throw new Error("el adjunto no se envió");
}

async function sendToOpenBot(page: Page, text: string): Promise<boolean> {
  return page.evaluate((mensaje) => {
    const editor = document.querySelector<HTMLElement>(".prompt-area-editor");
    if (!editor) return false;
    editor.focus();
    document.execCommand("insertText", false, mensaje);
    editor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        bubbles: true,
      }),
    );
    return true;
  }, text);
}

/**
 * Notas de estado: cuándo se entregó al equipo el último mensaje del usuario y
 * qué avisos ya se dieron, para que Telegram diga si el bot recibió y sigue
 * trabajando (y si lleva demasiado tiempo sin responder).
 */
let esperandoDesde = 0;
let avisadoProcesando = false;
let avisadoLento = false;
let ultimoAcuse = 0;

/** Confirma en Telegram que el mensaje ya entró al equipo y arranca el reloj. */
async function marcarEntrega(chatId: number): Promise<void> {
  esperandoDesde = Date.now();
  avisadoProcesando = false;
  avisadoLento = false;
  // En ráfaga basta un acuse: evita una nota por cada mensaje seguido.
  if (Date.now() - ultimoAcuse < 20_000) return;
  ultimoAcuse = Date.now();
  await sendTelegram(chatId, "📥 Recibido — procesando…");
}

/** Textos de las respuestas del bot (filas del transcript alineadas a la izquierda). */
async function snapshotReplies(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="message"][data-align="start"]')]
      .map((row) => {
        const content = row.querySelector('[data-slot="message-content"]');
        if (!content) return "";
        /** Reconstruye el formato: negritas (*x*), código (`x`) y listas (• ). */
        const render = (n: Node): string => {
          if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? "";
          const el = n as Element;
          const kids = [...el.childNodes].map(render).join("");
          switch (el.tagName) {
            case "STRONG":
            case "B":
              return kids.trim() ? `*${kids.trim()}*` : kids;
            case "CODE":
              return `\`${kids.trim()}\``;
            case "LI":
              return `• ${kids.trim()}\n`;
            case "BLOCKQUOTE": {
              const t = kids.trim().replace(/\n+/g, " ");
              return t ? `> ${t}\n` : "";
            }
            case "BR":
              return "\n";
            default:
              return kids;
          }
        };
        const texto = render(content)
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return texto;
      })
      .filter((t) => t.length > 0),
  );
}

/** Id de canal de una URL tipo .../channel/channel_<uuid>. */
function idDeCanal(p: Page): string {
  return /\/channel\/([A-Za-z0-9_-]+)/.exec(p.url())?.[1] ?? "";
}

/**
 * Firma de un texto retransmitido: se normaliza el espacio (el DOM re-monta
 * con variantes flotantes) y se corta; la probabilidad de colisión aquí es
 * imperceptible frente al daño de repetir una respuesta entera.
 */
function firmaTexto(t: string): string {
  return t.replace(/\s+/g, " ").trim().slice(0, 180);
}

/** Memoria durable de firmas ya retransmitidas de un canal. */
function firmasVistas(idCanal: string): Set<string> {
  return new Set(state.vistosTextos?.[idCanal] ?? []);
}

function recordarFirma(idCanal: string, firma: string): void {
  const todo = state.vistosTextos ?? {};
  const previas = todo[idCanal] ?? [];
  todo[idCanal] = [...new Set([...previas, firma])].slice(-250);
  state.vistosTextos = todo;
  saveState();
}

/**
 * Bucle de respuestas: un bloque se reenvía solo cuando su texto lleva ~4s sin
 * cambiar (el transcript hace streaming; así no se reenvía a medias). Lee
 * SIEMPRE la página y el chat actuales (currentPage / state.chatId), no copias
 * congeladas del arranque: si el canal se reabre, el vigilante lo sigue.
 *
 * La deduplicación es POR TEXTO (firmas durables en state.vistosTextos): un
 * mensaje retransmitido alguna vez — en este o cualquier proceso, tras
 * recargas del stream, regresos con /ir o reinicios del puente — jamás sale
 * otra vez por Telegram. Lo pendiente de verdad sale por tener firma nueva,
 * nada más.
 */
function watchReplies() {
  const pendientes = new Map<string, number>();
  /** Página ya barrida: al cambiar (reinicio, /new, recarga) se recarga el lente. */
  let paginaVista: Page | null = null;
  let yaVisto = new Set<string>();
  /** Canal sin memoria de firmas: espera a que el transcript aparezca y asiente. */
  let holding: Page | null = null;
  let esperas: number[] = [];
  let conteoPrevio = -1;
  let silencio = 0;
  let varHeart = 0;
  /** Diagnóstico temporal: DOM crudo para rastrear el conteo cero inexplicable. */
  let ultimoDiag = "";
  const diag = async (page: Page): Promise<string> => {
    try {
      const d = await page.evaluate(
        () =>
          `nodos=${document.querySelectorAll('[data-slot="message"]').length}` +
          ` start=${document.querySelectorAll('[data-slot="message"][data-align="start"]').length}` +
          ` aviso=${/temporarily unavailable/.test(document.body.innerText)} orden=${document.readyState}`,
      );
      if (d !== ultimoDiag) {
        ultimoDiag = d;
        return ` [dom ${d}]`;
      }
    } catch {
      /* la evaluación no es esencial aquí */
    }
    return "";
  };
  const tick = async () => {
    const page = currentPage;
    const chatId = state.chatId;
    if (!page || !chatId) return;
    try {
      const actual = await snapshotReplies(page);
      const idCanal = idDeCanal(page);
      varHeart = (varHeart ?? 0) + 1;
      if (varHeart % 8 === 0)
        LOG(
          `latido tick #${varHeart} · ${actual.length} msg · pendientes ${pendientes.size}` +
            (await diag(page)),
        );
      const url = page.url();
      if (url !== state.channelUrl && url.includes("/channel/")) {
        state.channelUrl = url;
        saveState();
      }
      // Perro guardián del transcript: la conexión de watch se muere en
      // silencio a ratos y la página no se da por enterada — el conteo queda
      // clavado y ni una respuesta nueva llega. Sin cambios de conteo en
      // ~90 s basta una recarga; las firmas de lo ya enviado impiden que la
      // historia re-montada salga de nuevo.
      if (pendientes.size > 0) {
        // Stream en curso: cuenta como actividad, no hay nada muerto aquí.
        silencio = 0;
        conteoPrevio = actual.length;
      } else if (actual.length === conteoPrevio) {
        silencio += 1;
        if (silencio >= 36) {
          silencio = 0;
          conteoPrevio = actual.length;
          LOG("transcript quieto ~90s: recargo por si el stream murió");
          await page
            .reload({ waitUntil: "domcontentloaded", timeout: 60_000 })
            .catch(() => {});
          // La recarga re-monta la historia con variantes de espacio que ya
          // no coinciden con el lente anterior: limpiar paginaVista fuerza el
          // recargado de firmas abajo y nada visto sale repetido.
          paginaVista = null;
          pendientes.clear();
          return;
        }
      } else {
        silencio = 0;
      }
      conteoPrevio = actual.length;
      if (page !== paginaVista) {
        paginaVista = page;
        yaVisto = firmasVistas(idCanal);
        pendientes.clear();
        holding = null;
        esperas = [];
        // Primer contacto con un canal (memoria vacía): toda la historia en
        // pantalla pasa al registro SIN reenviar — el propósito del migrado es
        // no repetir lo viejo; lo pendiente ya salió o sale vía /novedades.
        if (yaVisto.size === 0 && actual.length > 0) {
          for (const texto of actual) recordarFirma(idCanal, firmaTexto(texto));
          yaVisto = firmasVistas(idCanal);
        } else if (yaVisto.size === 0 && actual.length === 0) {
          // Carrera de arranque: el transcript puede seguir vacío a mitad de
          // montaje. No se decide con 0: queda en espera hasta que algo asiente.
          holding = page;
          esperas = [];
        }
        LOG(`canal ${idCanal}: memoria de firmas con ${yaVisto.size} textos`);
        return;
      }
      // Canal recién conocido con la página aún en blanco: no sembrar ni dejar
      // pasar nada hasta que el transcript asiente (últimos 2 conteos iguales
      // y > 0); entonces la historia entra al registro de una sola pieza y no
      // se filtra ningún mensaje viejo por la mitad del montaje.
      if (holding === page && yaVisto.size === 0) {
        esperas.push(actual.length);
        const fin = esperas.at(-1) ?? 0;
        const ant = esperas.at(-2) ?? -1;
        if (fin > 0 && fin === ant) {
          for (const texto of actual) recordarFirma(idCanal, firmaTexto(texto));
          yaVisto = firmasVistas(idCanal);
          holding = null;
          esperas = [];
          pendientes.clear();
          LOG(`canal ${idCanal}: sembrado inicial con ${yaVisto.size} textos`);
        }
        return;
      }
      for (const texto of actual) {
        const firma = firmaTexto(texto);
        if (yaVisto.has(firma)) continue;
        const desde = pendientes.get(texto) ?? Date.now();
        pendientes.set(texto, desde);
        if (Date.now() - desde < 4000) continue;
        pendientes.delete(texto);
        yaVisto.add(firma);
        recordarFirma(idCanal, firma);
        registrar("Equipo", texto);
        await sendTelegram(chatId, texto);
        // Llegó respuesta: el acuse de "procesando" ya no aplica.
        esperandoDesde = 0;
        avisadoProcesando = false;
        avisadoLento = false;
        LOG("→ Telegram:", texto.slice(0, 80).replace(/\n/g, " "), "…");
      }
      // Notas de estado para saber que el equipo sigue trabajando en lo último
      // que le mandaste: un aviso a los ~2 min y otro a los ~10 si no hay nada.
      if (esperandoDesde > 0) {
        const espera = Date.now() - esperandoDesde;
        if (espera > 120_000 && !avisadoProcesando) {
          avisadoProcesando = true;
          await sendTelegram(chatId, "⏳ Sigo procesando — aún sin respuesta.");
        }
        if (espera > 600_000 && !avisadoLento) {
          avisadoLento = true;
          await sendTelegram(
            chatId,
            "⚠️ Llevo más de 10 minutos sin respuesta. Puede que el equipo espere algo tuyo en OpenBot (por ejemplo, iniciar sesión en el panel Computer).",
          );
        }
      }
    } catch (err) {
      LOG("vigilancia de respuestas:", String(err).slice(0, 140));
    }
  };
  return { tick };
}

// --- Aprobaciones y preguntas: el servidor los tiene durables; aquí se retransmiten ---

const retransmitidas = new Set<string>();

/** Retransmite aprobaciones pendientes con botones, y preguntas pendientes. */
async function pollAprobaciones(chatId: number): Promise<void> {
  const res = await fetch(`${OPENBOT_URL}/api/approvals`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return;
  const caja = (await res.json()) as {
    requests?: {
      id: string;
      status: string;
      action: {
        toolRef?: string;
        effect?: string;
        scope?: string;
        policy?: { behaviour?: string; reason?: string } | null;
      };
    }[];
    questions?: { id: string; question: string; why?: string }[];
  };
  for (const req of caja.requests ?? []) {
    if (req.status !== "pending" || retransmitidas.has(req.id)) continue;
    retransmitidas.add(req.id);
    const esEntrega = req.action.policy?.behaviour === "hand_off";
    const teclado = esEntrega
      ? {
          inline_keyboard: [
            [
              { text: "🙋 Yo lo hago", callback_data: `apr:handled:${req.id}` },
              { text: "🚫 No lo hagas", callback_data: `apr:deny:${req.id}` },
            ],
          ],
        }
      : {
          inline_keyboard: [
            [
              {
                text: "✅ Aprobar 1 vez",
                callback_data: `apr:allow_once:${req.id}`,
              },
              {
                text: "🔁 Siempre aquí",
                callback_data: `apr:allow_always:${req.id}`,
              },
            ],
            [{ text: "❌ Rechazar", callback_data: `apr:deny:${req.id}` }],
          ],
        };
    const accion = (req.action.toolRef ?? "")
      .replace(/^computer_/, "")
      .replaceAll("_", " ");
    await sendTelegram(
      chatId,
      `🔐 El Bot pidió tu aprobación.\n• Acción: ${accion}\n• Alcance: ${req.action.scope ?? "-"}${
        req.action.policy?.reason
          ? `\n• Motivo: ${req.action.policy.reason}`
          : ""
      }`,
      teclado,
    );
    LOG("aprobación retransmitida:", req.id);
  }
  for (const q of caja.questions ?? []) {
    if (retransmitidas.has(q.id)) continue;
    retransmitidas.add(q.id);
    await sendTelegram(
      chatId,
      `❓ El Bot necesita una respuesta (respóndela en la app para que retome el turno):\n${q.question}${
        q.why ? `\n\n¿Por qué: ${q.why}` : ""
      }`,
    );
  }
}

/** Ejecuta la decisión de un botón de Telegram contra la API del servidor. */
async function decidirAprobacion(cq: any): Promise<void> {
  const respuesta = async (texto: string) => {
    try {
      await tg("answerCallbackQuery", {
        callback_query_id: cq.id,
        text: texto,
      });
    } catch {}
    if (cq?.message?.chat?.id)
      await sendTelegram(cq.message.chat.id, texto).catch(() => {});
  };
  try {
    const [, choice, id] = String(cq.data).split(":");
    if (
      choice !== "allow_once" &&
      choice !== "allow_always" &&
      choice !== "deny" &&
      choice !== "handled"
    ) {
      await respuesta("Botón no reconocido.");
      return;
    }
    const res = await fetch(
      `${OPENBOT_URL}/api/approvals/${encodeURIComponent(id)}/decision`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: choice }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (res.ok) {
      await respuesta(
        choice === "deny"
          ? "🚫 Rechazado."
          : choice === "handled"
            ? "🙋 Registrado: lo haces tú; el Bot retoma el turno."
            : "✅ Aprobado; la acción ejecuta y el turno continúa.",
      );
    } else {
      await respuesta("No se pudo registrar (¿ya estaba decidida?).");
    }
  } catch (err) {
    LOG("decisión de aprobación:", String(err).slice(0, 120));
    await respuesta("Error al registrar la decisión.");
  }
}

// --- Registro: cada llamada y cada respuesta quedan en la bóveda (Obsidian) ---

const VAULT = fileURLToPath(new URL("../registros", import.meta.url));

function appendFile(dir: string, data: string): void {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
}

function registrar(quien: string, texto: string): void {
  try {
    const forma = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const [dia, hora] = forma.format(new Date()).split(" ");
    appendFile(`${VAULT}/01 Diario`, "");
    const careta = `${VAULT}/01 Diario/${dia}.md`;
    if (!existsSync(careta)) writeFileSync(careta, `# Diario ${dia}\n`, "utf8");
    appendFileSync(
      careta,
      `\n## ${hora.slice(0, 5)} — ${quien}\n\n${texto}\n`,
      "utf8",
    );
  } catch (err) {
    LOG("registro:", String(err).slice(0, 100));
  }
}

// --- Voz (whisper en Groq) ---

async function transcribeVoice(fileId: string): Promise<string | null> {
  if (!GROQ_KEY || GROQ_KEY.includes("AQU") || !GROQ_KEY.startsWith("gsk_"))
    return null;
  try {
    const info = await tg("getFile", { file_id: fileId });
    const bin = await fetch(
      `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`,
      {
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (!bin.ok) return null;
    const form = new FormData();
    form.append("file", new Blob([await bin.arrayBuffer()]), "nota-de-voz.ogg");
    form.append("model", GROQ_MODEL);
    form.append("response_format", "text");
    const res = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      },
    );
    if (!res.ok) {
      LOG("whisper falló:", res.status, (await res.text()).slice(0, 140));
      return null;
    }
    return (await res.text()).trim() || null;
  } catch (err) {
    LOG("transcripción:", String(err).slice(0, 140));
    return null;
  }
}

// --- Bandeja bot-a-bot (reclama tareas `para: "opencode"`, corre `opencode run` en headless) ---

/** Saca el texto y el id de sesión de los eventos JSON de `opencode run --format json`. */
function extraerRespuesta(salida: string): {
  texto: string;
  sesion: string | null;
} {
  const textos: string[] = [];
  let sesion: string | null = null;
  for (const linea of salida.split("\n")) {
    const l = linea.trim();
    if (!l.startsWith("{")) continue;
    try {
      const ev = JSON.parse(l);
      if (!sesion && typeof ev?.sessionID === "string") sesion = ev.sessionID;
      if (ev?.type === "text" && typeof ev?.part?.text === "string")
        textos.push(ev.part.text);
    } catch {}
  }
  return { texto: textos.join("\n").trim() || salida.trim(), sesion };
}

async function tickBandeja(): Promise<void> {
  if (bandejaOcupada) return;
  // Vigilancia detenida a mano (MCP vigilancia_detener): el buzón acumula.
  if (existsSync(join(BANDEJA_DIR, "vigilancia.off"))) {
    if (!bandejaFueraAviso) {
      LOG("bandeja: vigilancia detenida, en espera");
      bandejaFueraAviso = true;
    }
    return;
  }
  // Fuera de horario la bandeja acumula sin ejecutar (el buzón siempre recibe).
  if (!enHorario()) {
    if (!bandejaFueraAviso) {
      LOG("bandeja: fuera de horario, en espera");
      bandejaFueraAviso = true;
    }
    return;
  }
  bandejaFueraAviso = false;
  let archivos: string[];
  try {
    archivos = readdirSync(BANDEJA_DIR).filter(
      (f) =>
        f.endsWith(".tarea.json") && !f.startsWith("_") && !f.startsWith("."),
    );
  } catch {
    return; // sin bandeja = nada que delegar
  }
  for (const archivo of archivos) {
    const id = archivo.slice(0, -".tarea.json".length);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    // Ya atendida o en curso: el .resultado.json manda, nada se repite.
    if (
      existsSync(join(BANDEJA_DIR, `${id}.resultado.json`)) ||
      existsSync(join(BANDEJA_DIR, `${id}.en_proceso.json`))
    )
      continue;
    let tarea: any;
    try {
      tarea = JSON.parse(readFileSync(join(BANDEJA_DIR, archivo), "utf8"));
    } catch {
      continue;
    }
    if (tarea?.para !== "opencode") continue; // la reclama otro ejecutor
    if (typeof tarea?.tarea !== "string" || !tarea.tarea.trim()) continue;
    // Con destino nombrado la reclama una sesión viva vía MCP, no el ejecutor.
    if (typeof tarea?.destino === "string" && tarea.destino.trim()) continue;
    bandejaOcupada = true;
    // Reclamar: el rename es atómico, dos ejecutores no toman la misma tarea.
    let reclamada = false;
    try {
      renameSync(
        join(BANDEJA_DIR, archivo),
        join(BANDEJA_DIR, `${id}.en_proceso.json`),
      );
      reclamada = true;
      // Hilo opcional: `dir` (carpeta de trabajo dentro de Base/) y `sesion`
      // (ses_* a continuar) permiten que el hilo viva donde está el trabajo.
      const BASE_DIR = resolve(BANDEJA_DIR, "..", "..");
      let cwdDir = LAB_DIR;
      const dirPed = typeof tarea?.dir === "string" ? tarea.dir.trim() : "";
      if (dirPed) {
        const res = resolve(BASE_DIR, dirPed);
        let esDir = false;
        try {
          esDir = statSync(res).isDirectory();
        } catch {}
        if (res !== BASE_DIR && !res.startsWith(BASE_DIR + sep)) {
          throw new Error(`dir fuera de Base/: ${dirPed}`);
        }
        if (!esDir) throw new Error(`dir no existe: ${dirPed}`);
        cwdDir = res;
      }
      const sesionPed =
        typeof tarea?.sesion === "string" &&
        /^ses_[A-Za-z0-9]+$/.test(tarea.sesion)
          ? tarea.sesion
          : null;
      LOG("bandeja: ejecutando", id);
      // Bun.spawn con stdin ignorado: detached no hay consola que heredar y
      // heredarla bloquea al hijo para siempre.
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(
          [
            OPENCODE_BIN,
            "run",
            "--format",
            "json",
            ...(sesionPed ? ["--session", sesionPed] : []),
            tarea.tarea.trim(),
          ],
          { cwd: cwdDir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
      } catch (err) {
        throw new Error(
          `no arranca ${OPENCODE_BIN}: ${String(err).slice(0, 160)}`,
        );
      }
      const fin: unknown = await Promise.race([
        proc.exited,
        new Promise((r) => setTimeout(() => r("tiempo"), BANDEJA_TIMEOUT)),
      ]);
      if (fin === "tiempo") {
        try {
          proc.kill();
        } catch {}
        await proc.exited.catch(() => {});
      }
      const salida = await new Response(proc.stdout).text().catch(() => "");
      const errores = await new Response(proc.stderr).text().catch(() => "");
      const tiempoAgotado = fin === "tiempo";
      const ok = !tiempoAgotado && proc.exitCode === 0;
      const respuesta = extraerRespuesta(salida);
      // Otro ejecutor pudo cerrarla mientras corríamos: no pisar su resultado.
      if (existsSync(join(BANDEJA_DIR, `${id}.resultado.json`))) {
        LOG("bandeja:", id, "ya cerrada por otro ejecutor");
        try {
          rmSync(join(BANDEJA_DIR, `${id}.en_proceso.json`));
        } catch {}
        return;
      }
      const detalle = ok
        ? respuesta.texto.slice(0, 4000) || "(sin salida)"
        : `exit ${proc.exitCode ?? "?"}: ${(errores.trim() || salida.trim()).slice(0, 2000) || "sin detalle"}`;
      const resultado = {
        id,
        estado: ok ? "listo" : "error",
        resumen: tiempoAgotado
          ? `tiempo agotado (${BANDEJA_TIMEOUT / 60000} min)`
          : detalle,
        sesion: respuesta.sesion,
        terminada: new Date().toISOString(),
      };
      writeFileSync(
        join(BANDEJA_DIR, `${id}.resultado.json`),
        JSON.stringify(resultado, null, 2),
      );
      const aviso =
        `Bandeja ${id} (${resultado.estado})` +
        (respuesta.sesion ? ` [${respuesta.sesion.slice(4, 12)}]` : "") +
        `: ${resultado.resumen.slice(0, 1400)}`;
      registrar("bandeja", aviso);
      LOG("bandeja:", id, resultado.estado);
      if (currentPage) {
        try {
          await sendToOpenBot(currentPage, aviso);
        } catch (err) {
          LOG("bandeja (aviso):", String(err).slice(0, 120));
        }
      }
    } catch (err) {
      // Nunca dejar la tarea atorada en .en_proceso: el error también es un resultado.
      LOG("bandeja:", id, String(err).slice(0, 160));
      if (reclamada) {
        try {
          writeFileSync(
            join(BANDEJA_DIR, `${id}.resultado.json`),
            JSON.stringify({
              id,
              estado: "error",
              resumen: String(err).slice(0, 2000),
              terminada: new Date().toISOString(),
            }),
          );
        } catch {}
      }
    } finally {
      try {
        rmSync(join(BANDEJA_DIR, `${id}.en_proceso.json`));
      } catch {}
      bandejaOcupada = false;
    }
  }
}

// --- Principal ---

async function main() {
  if (!TOKEN || !TOKEN.includes(":")) {
    console.error(
      "Falta TELEGRAM_BOT_TOKEN en el .env (créalo con @BotFather en Telegram y pega el token ahí).",
    );
    process.exit(1);
  }
  LOG("esperando a OpenBot en", OPENBOT_URL, "…");
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(OPENBOT_URL, { signal: AbortSignal.timeout(5000) });
      if (r.ok) break;
    } catch {}
    if (i >= 150) process.exit(1);
    await new Promise((r) => setTimeout(r, 2000));
  }
  LOG("OpenBot arriba. Abriendo canal del", AGENT, "…");

  const browser = await launchBrowser();
  currentPage = await openChannel(browser);
  let reinicios = 0;

  const bot = await tg("getMe");
  const ayuda =
    `Conectado al equipo de OpenBot (hablas con el ${AGENT}).\n` +
    "• Manda texto y lo delega a los especialistas.\n" +
    "• Manda una NOTA DE VOZ y la transcribe (whisper) antes de enviarla.\n" +
    "• /new abre una conversación nueva con el equipo.\n" +
    "• /sesiones lista tus conversaciones anteriores; /ir 2 regresa a la 2.\n" +
    "• /novedades 2 manda el último mensaje que el equipo dejó en la sesión 2.\n" +
    "• /poda borra sesiones viejas: /poda arma el plan y /poda SÍ lo ejecuta.\n" +
    "• /refresca copia la bóveda al workspace del equipo y le pide releerla.\n" +
    "• /help repite esto.";
  await tg("setMyCommands", {
    commands: [
      { command: "new", description: "Conversación nueva con el equipo" },
      {
        command: "sesiones",
        description: "Sesiones anteriores · /ir N regresa a la N",
      },
      {
        command: "novedades",
        description: "Último mensaje de otra sesión · /novedades N",
      },
      {
        command: "poda",
        description: "Borra sesiones viejas · /poda arma, /poda SÍ ejecuta",
      },
      {
        command: "refresca",
        description: "Refresca el conocimiento de la bóveda Obsidian",
      },
      { command: "help", description: "Ayuda" },
    ],
  });

  let offset = 0;
  const { tick } = watchReplies();
  setInterval(tick, 2500);
  // Inbox de aprobaciones/preguntas: retransmite lo nuevo a Telegram.
  setInterval(() => {
    const chat = state.chatId;
    if (!chat) return;
    pollAprobaciones(chat).catch((err) =>
      LOG("aprobaciones:", String(err).slice(0, 120)),
    );
  }, 7000);
  // Escucha de correos (Gmail vía Composio): latido cada 3 min y uno inmediato
  // para sembrar la memoria — la primera vuelta NO avisa los cientos actuales.
  tickCorreos().catch((err) =>
    LOG("correos (arranque):", String(err).slice(0, 120)),
  );
  setInterval(() => {
    tickCorreos().catch((err) =>
      LOG("correos (intervalo):", String(err).slice(0, 120)),
    );
  }, INTERVALO_CORREOS);
  // Bandeja bot-a-bot: ejecuta tareas `para: "opencode"` sin pasar por el chat.
  setInterval(() => {
    tickBandeja().catch((err) =>
      LOG("bandeja (intervalo):", String(err).slice(0, 120)),
    );
  }, BANDEJA_INTERVALO);

  LOG("escuchando Telegram como", bot.username, "…");
  for (;;) {
    try {
      const updates = await tg("getUpdates", {
        offset,
        timeout: 25,
        allowed_updates: ["message"],
      });
      for (const u of updates as any[]) {
        offset = u.update_id + 1;
        if (u.callback_query) {
          await decidirAprobacion(u.callback_query);
          continue;
        }
        const msg = u.message;
        if (!msg?.chat?.id) continue;
        const chatId = msg.chat.id as number;

        // Vínculo del primer chat (o lista blanca si se definió).
        if (!state.chatId) {
          if (ALLOWED.length && !ALLOWED.includes(String(chatId))) continue;
          state.chatId = chatId;
          saveState();
          LOG("chat vinculado:", chatId);
          await sendTelegram(chatId, ayuda);
          continue;
        }
        if (chatId !== state.chatId) {
          await sendTelegram(chatId, "Este puente está vinculado a otro chat.");
          continue;
        }

        if (msg.text?.startsWith("/sesiones") || msg.text?.startsWith("/ir ")) {
          // La lista se pide A CADA toque: es la misma que la app ve, sin una copia local que
          // envejezca. `/sesiones` la enseña numerada; `/ir N` (y `/sesiones N`) regresa a la N.
          const sesiones = await listarSesiones().catch(() => []);
          if (!sesiones.length) {
            await sendTelegram(
              chatId,
              "No tengo sesiones guardadas todavía. Manda /new para abrir la primera.",
            );
            continue;
          }
          const pedido = msg.text.trim().split(/\s+/)[1] ?? "";
          const numero = Number.parseInt(pedido, 10);
          if (Number.isInteger(numero)) {
            const elec = sesiones[numero - 1];
            if (!elec) {
              await sendTelegram(
                chatId,
                `Ese número no está en la lista (van 1 a ${sesiones.length}).`,
              );
              continue;
            }
            // Aviso honesto ANTES de cerrar la página: si el equipo de la sesión
            // actual está procesando algo, ese resultado quedará escrito en SU
            // sesión y no saldrá por Telegram hasta regresar. Mejor un aviso
            // oportuno que una respuesta que ni se enteró nadie.
            let aviso = "";
            if (currentPage && (await composerBusy(currentPage))) {
              aviso =
                "\n⚠️ La sesión anterior seguía procesando algo: su respuesta no llegará por Telegram hasta que vuelvas a ella.";
            }
            state.channelUrl = `${OPENBOT_URL}/channel/${elec.id}`;
            saveState();
            await currentPage?.close().catch(() => {});
            currentPage = await openChannel(browser, state.channelUrl);
            await sendTelegram(
              chatId,
              `↩️ De vuelta en la sesión ${numero}:\n${resumenSesion(elec, numero)}${
                aviso ||
                "\nSi esta sesión tenía respuestas pendientes, solo esas te llegan ahora."
              }`,
            );
            continue;
          }
          const lista = sesiones
            .slice(0, 8)
            .map((s, i) => resumenSesion(s, i + 1))
            .join("\n");
          await sendTelegram(
            chatId,
            `📚 Sesiones (más reciente arriba):\n${lista}\n\nManda /ir 2 para regresar a la 2.`,
          );
          continue;
        }
        if (msg.text?.startsWith("/novedades")) {
          // Lectura a demanda, no vigilancia: qué dijo el equipo por última
          // vez en la sesión N, sin cambiar de sesión. Útil para lo que quedó
          // corriendo cuando cambiaste de sesión.
          const sesiones = await listarSesiones().catch(() => []);
          const pedido = msg.text.trim().split(/\s+/)[1] ?? "";
          const numero = Number.parseInt(pedido, 10);
          if (!Number.isInteger(numero)) {
            await sendTelegram(
              chatId,
              "Dime cuál: /novedades 2 te manda el último mensaje de la sesión 2.",
            );
            continue;
          }
          const elec = sesiones[numero - 1];
          if (!elec) {
            await sendTelegram(
              chatId,
              `Ese número no está en la lista (van ${sesiones.length}). Manda /sesiones primero.`,
            );
            continue;
          }
          await sendTelegram(chatId, "🔎 Leyendo la otra sesión…");
          const ultimo = await ultimoDeSesion(browser, elec.id).catch(
            () => null,
          );
          await sendTelegram(
            chatId,
            ultimo
              ? `📩 Último mensaje de «${elec.name?.trim() || "sesión sin nombre"}»:\n\n${ultimo}`
              : "Sin mensaje legible en esa sesión (puede que su última respuesta quedara a medias).",
          );
          continue;
        }
        if (msg.text?.startsWith("/poda")) {
          // Podar sesiones: borrar (borrado suave, como el botón de cerrar de la app) las
          // que ya no se usan. La activa JAMÁS se borra. Dos pasos para que un toque
          // accidental no deje a nadie sin conversaciones: /poda arma el plan,
          // /poda SÍ lo ejecuta; el plan expira a los 5 minutos.
          const sesiones = await listarSesiones().catch(() => []);
          if (!sesiones.length) {
            await sendTelegram(
              chatId,
              "No hay sesiones que podar. Manda /new para abrir la primera.",
            );
            continue;
          }
          const activo = state.channelUrl?.includes("/channel/")
            ? state.channelUrl.split("/channel/")[1]?.split(/[?#]/)[0]
            : undefined;
          const arg = (msg.text.trim().split(/\s+/)[1] ?? "").toUpperCase();

          if (arg === "SÍ" || arg === "SI") {
            const plan = state.podaPendiente;
            state.podaPendiente = undefined;
            saveState();
            if (!plan?.ids.length || Date.now() - plan.cuando > 5 * 60_000) {
              await sendTelegram(
                chatId,
                "No hay plan de poda pendiente (o ya expiró). Manda /poda para armar uno.",
              );
              continue;
            }
            let ok = 0;
            let fallaron = 0;
            for (const id of plan.ids) {
              try {
                await borrarSesion(id);
                ok++;
              } catch {
                fallaron++;
              }
            }
            const restantes = await listarSesiones().catch(() => sesiones);
            const nombresRest = restantes
              .slice(0, 4)
              .map((s) => `· ${s.name?.trim() || "sesión sin nombre"}`)
              .join("\n");
            await sendTelegram(
              chatId,
              fallaron
                ? `🗑️ Podé ${ok}, ${fallaron} no se dejaron borrar. Quedan ${restantes.length} sesiones.\n${nombresRest}`
                : `🗑️ Podé ${ok}. Quedan ${restantes.length} sesiones:\n${nombresRest}`,
            );
            continue;
          }

          const conservar =
            arg === "TODO"
              ? 1
              : (() => {
                  const n = Number.parseInt(arg, 10);
                  return Number.isInteger(n) && n >= 1 ? n : 3;
                })();
          const keepers = new Set<string>();
          if (activo) keepers.add(activo);
          for (const s of sesiones.slice(0, conservar)) keepers.add(s.id);
          const idsBorrables = sesiones
            .filter((s) => !keepers.has(s.id))
            .map((s) => s.id);
          if (!idsBorrables.length) {
            state.podaPendiente = undefined;
            saveState();
            await sendTelegram(
              chatId,
              `Nada que podar: hay ${sesiones.length} en total y conservar ${arg === "TODO" ? "solo la activa" : arg || "3"} no las deja fuera.`,
            );
            continue;
          }
          const nombresBorrables = sesiones
            .filter((s) => idsBorrables.includes(s.id))
            .slice(0, 12)
            .map((s) => `· ${s.name?.trim() || "sesión sin nombre"}`);
          state.podaPendiente = {
            ids: idsBorrables,
            quedan: sesiones.length - idsBorrables.length,
            cuando: Date.now(),
          };
          saveState();
          await sendTelegram(
            chatId,
            `🗑️ Poda: borraría ${idsBorrables.length} y quedarían ${sesiones.length - idsBorrables.length} (la activa y las más recientes).\n\n` +
              nombresBorrables.join("\n") +
              (idsBorrables.length > 12
                ? `\n· …y ${idsBorrables.length - 12} más`
                : "") +
              "\n\nManda /poda SÍ para ejecutarlo · /poda TODO conserva solo la activa · /poda 5 conserva 5.",
          );
          continue;
        }
        if (msg.text?.startsWith("/refresca")) {
          // Conocimiento de la bóveda en dos pasos: la computadora del equipo
          // no ve registros/ (es un volumen aparte), así que (1) la copia al
          // workspace con docker cp y (2) le pide releerla y actualizar su
          // memoria. Un refresco de conocimiento vivo, no un índice mágico.
          await sendTelegram(
            chatId,
            "🔄 Copiando la bóveda al workspace del equipo…",
          );
          try {
            await execFileAsync(
              "docker",
              [
                "cp",
                `${VAULT}/.`,
                "opbt-agent-computer-1:/workspace/registros",
              ],
              { timeout: 30_000 },
            );
            const page = currentPage;
            if (!page) throw new Error("canal cerrado");
            await waitForFree(chatId);
            const listo = await sendToOpenBot(
              page,
              "Refresca tu base de conocimiento de la bóveda Obsidian: rele /workspace/registros (00 Mapa, 01 Diario de los últimos 3 días, 02 Preferencias del usuario, 03 Recordatorios, 04 Proyectos) y confirma en 2-3 líneas qué cambió en su comprensión. Sin preguntas.",
            );
            if (!listo) throw new Error("no pude escribir en el compositor");
            await sendTelegram(
              chatId,
              "🔄 Bóveda copiada y releo en camino: el documentalista la revisa y te reporta.",
            );
            LOG("refresca: bóveda copiada y pedido enviado al canal");
            // El equipo edita SU copia del workspace; las actualizaciones regresan
            // a la bóveda real tras darle tiempo a terminar (ida y vuelta, no un
            // espejo en vivo: la próxima /refresca vuelve a alinear los dos lados).
            setTimeout(() => {
              execFileAsync(
                "docker",
                ["cp", "opbt-agent-computer-1:/workspace/registros/.", VAULT],
                { timeout: 30_000 },
              )
                .then(() =>
                  LOG("refresca: cambios del equipo regresados a la bóveda"),
                )
                .catch((err) =>
                  LOG("refresca (regreso):", String(err).slice(0, 140)),
                );
            }, 180_000);
          } catch (err) {
            await sendTelegram(
              chatId,
              `⚠️ No pude refrescar: ${String(err).slice(0, 120)}`,
            );
            LOG("refresca falló:", String(err).slice(0, 140));
          }
          continue;
        }
        if (msg.text?.startsWith("/new")) {
          state.channelUrl = undefined;
          saveState();
          await currentPage?.close().catch(() => {});
          currentPage = await openChannel(browser);
          // Canal recién nacido: marcar su memoria para que el vigilante no
          // lo trate como "historial por sembrar" y se coma su primera
          // respuesta esperando un montaje que no existe.
          const nuevoId = /\/channel\/([A-Za-z0-9_-]+)/.exec(
            currentPage?.url() ?? "",
          )?.[1];
          if (nuevoId) recordarFirma(nuevoId, "·canal-nuevo·");
          await sendTelegram(
            chatId,
            "Conversación nueva abierta con el equipo.",
          );
          continue;
        }
        if (msg.text?.startsWith("/help") || msg.text?.startsWith("/start")) {
          await sendTelegram(chatId, ayuda);
          continue;
        }

        // Nota de voz → texto; texto → tal cual; imagen → aviso honesto.
        let texto = msg.text?.trim() ?? "";
        if (!texto && msg.voice) {
          const dicho = await transcribeVoice(msg.voice.file_id);
          if (!dicho) {
            await sendTelegram(
              chatId,
              "No pude transcribir la nota de voz. Revisa TRANSCRIPTION_API_KEY en el .env (clave de Groq).",
            );
            continue;
          }
          texto = `(nota de voz) ${dicho}`;
        }
        // Imagen (con o sin leyenda) o documento: se descarga y se adjunta al
        // compositor. El modelo MiniMax M3.1 Flash SÍ lee imágenes.
        const adjunto = msg.photo
          ? (() => {
              const mejor = [...(msg.photo as any[])].sort(
                (a, b) => (b.width ?? 0) - (a.width ?? 0),
              )[0];
              return {
                fileId: mejor.file_id as string,
                nombre: "foto.jpg",
                mime: "image/jpeg",
              };
            })()
          : msg.document
            ? {
                fileId: msg.document.file_id as string,
                nombre: msg.document.file_name ?? "archivo",
                mime: msg.document.mime_type ?? "application/octet-stream",
              }
            : null;
        if (adjunto && typeof adjunto.fileId === "string") {
          if (!(await waitForFree(chatId))) {
            await sendTelegram(
              chatId,
              "⚠️ El canal siguió ocupado más de 10 minutos. Manda /new para forzar una conversación nueva.",
            );
            continue;
          }
          try {
            const info = await tg("getFile", { file_id: adjunto.fileId });
            const bin = await fetch(
              `https://api.telegram.org/file/bot${TOKEN}/${info.file_path}`,
              { signal: AbortSignal.timeout(120_000) },
            );
            if (!bin.ok) throw new Error(`descarga ${bin.status}`);
            const buffer = Buffer.from(await bin.arrayBuffer());
            const page = currentPage;
            if (!page) throw new Error("sin página");
            await adjuntarYEnviar(
              page,
              adjunto.nombre,
              adjunto.mime,
              buffer,
              msg.caption ?? null,
            );
            LOG("→ OpenBot: [adjunto", adjunto.nombre, buffer.length, "bytes]");
            await marcarEntrega(chatId);
          } catch (err) {
            LOG("adjunto falló:", String(err).slice(0, 140));
            await sendTelegram(
              chatId,
              "No pude adjuntar el archivo en el chat del equipo. Inténtalo otra vez o pégalo directo en la app.",
            );
          }
          continue;
        }
        if (!texto) continue;

        // Cola: no escribir mientras corre un turno (el aparcar pierde mensajes).
        registrar("Tú", texto);
        if (!(await waitForFree(chatId))) {
          await sendTelegram(
            chatId,
            "⚠️ El canal siguió ocupado más de 10 minutos. Manda /new para forzar una conversación nueva.",
          );
          continue;
        }
        try {
          if (!currentPage) throw new Error("sin página");
          if (!(await sendToOpenBot(currentPage, texto)))
            throw new Error("sin editor");
          LOG("→ OpenBot:", texto.slice(0, 80).replace(/\n/g, " "), "…");
          await marcarEntrega(chatId);
        } catch (err) {
          LOG("reabriendo canal:", String(err).slice(0, 140));
          if (++reinicios > 10) process.exit(1);
          await currentPage?.close().catch(() => {});
          currentPage = await openChannel(browser);
          if (!(await waitForFree(chatId))) continue;
          await sendToOpenBot(currentPage, texto);
          await marcarEntrega(chatId);
        }
      }
    } catch (err) {
      LOG("bucle Telegram:", String(err).slice(0, 160));
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main();
