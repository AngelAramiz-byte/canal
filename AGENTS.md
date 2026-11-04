# AGENTS.md

Instrucciones para sesiones de agente (OpenCode u otro) trabajando en `C:\Users\IRSDEMEXICO\Desktop\Base\plataforma\OPBT`.
Este repo es **OpenBot** (clon de `CopilotKit/openbot`, MIT) adaptado como despliegue local de producción
en **Windows**: además del upstream tiene personalizaciones locales — `bridge/`, supervisión/lanzadores `.cmd`
y `.ps1` en `scripts/`, diario en `registros/`, logs en `.logs/`. Trata el upstream como base portable y
lo local cableado a esta máquina.

## Comandos (raíz, Bun — nada de npm/node directo)

```sh
cp .env.example .env        # primera vez; luego bun install
bash scripts/start.sh       # pila completa: Docker, migraciones, server 3001, app 3010, worker
bash scripts/stop.sh        # baja todo (incluye computadoras de bots que compose NO posee)
bun run dev                 # solo app + server, sin Docker/bots
```

- Calidad en este orden (como lo exige CI/PR): `bun run format:check` → `lint` → `typecheck` → `test` → `build`.
- Un archivo: `bun test server/tests/<nombre>.test.ts`. `pretest` corre primero `generate:app-config` (no lo salte a mano).
- Migraciones Drizzle: `bun run --filter server db:generate` y luego `db:migrate`. **Nunca editar a mano una migración generada**; los pasos de datos van aparte con `db:generate -- --custom --name=...` (docs/development.md). Tras rebase, si `drizzle-kit migrate` cuelga sin error: comparar `server/drizzle/meta/_journal.json` contra `ls server/drizzle/*.sql`.
- Tests de integración necesitan PostgreSQL con pgvector en `TEST_DATABASE_URL` (db dedicada, p. ej. `openbot_test`) y **se niegan a usar la db de la app** (`DATABASE_URL`). Sin eso se saltan silenciosamente.
- `bun run test:smoke` necesita la pila arriba y `OPENBOT_SMOKE_COOKIE='better-auth.session_token=...'` (cookie real de la app; es credencial: no va a archivos ni PRs). `test:live-screen` requiere `cd agent-computer && bun install` antes (Playwright vive solo en ese workspace).
- Puente Telegram (local): verificar que compila con `bun build --no-bundle bridge/telegram-bridge.ts` (Bun no hace typecheck aquí); corre con Bun directo. Para reiniciarlo, matar solo el proceso bun cuyo CommandLine contenga `telegram-bridge` (nunca otros bun) y relanzarlo escribiendo su salida a `.logs/telegram-bridge.log` (`openbot-telegram.cmd`).

## Arquitectura en una pasada

- Workspaces Bun: `app` (Vite/React, SecureChat UI) · `server` (Hono + better-auth + Drizzle/Postgres, puerta AG-UI y gateway de herramientas + auditoría) · `worker` (rutinas programadas) · `shared` · `toolkit`. Los `agent-*` de la raíz son ejemplos de Bots AG-UI independientes; `agent-computer` es el navegador real de cada Bot.
- Un Bot = cualquier endpoint que hable AG-UI; el tenant de ejemplo vive en `examples/fintech/` (agents/catálogo). Bots de producción aquí: configuración, no código.
- Puertos: app **3010**, server **3001**, `agent-computer` 4100, `agent-bot` 4200, `agent-langgraph` 4201, supervisor 4500 host/4300 contenedor, Postgres 5432.
- Entradas del server: `server/src/index.ts` (dev) y `server/src/production-entry.ts` (producción — hace preload ESM de `eventsource`; no borrar el import "magic"). El worker corre `worker/src/index.ts`.
- Env: cada script de `server/` usa `bun --env-file=../.env` (se corre desde `server/`, no de la raíz). Bun ya carga el `.env` de la raíz autom. para scripts raíz.
- `scripts/start.sh` es idempotente y es el reconciliador que usa el supervisor; define `WORKER_SHARED_SECRET=openbot-dev-worker-secret` si el `.env` lo trae vacío — dejarlo así (si no, cada reconciliación reinicia el server/worker por desacuerdo de secreto).
- Delegaciones bot-a-bot (bots fuera de esta PC): `POST /api/delegaciones` + `GET /api/delegaciones/:id` + `POST /:id/resultado` (bearer `WORKER_SHARED_SECRET`, misma credencial que el worker) y `GET /.well-known/agent-card.json` para descubrimiento A2A (`server/src/delegaciones/routes.ts`, tipos `delegation.*` en `audit.ts`). Acepta `dir` (dentro de `Base/`), `sesion` (`ses_*`) y `destino` opcionales; con `destino` el ejecutor automático lo ignora y lo toma una sesión viva. Suscriptores push en `../bandeja/suscriptores.json` (ver `bandeja/README.md`). Escriben a la misma `../bandeja/`. Test sin DB: `bun test server/tests/delegaciones.test.ts`.

## Archivos mágicos que no romper sin querer

- `bunfig.toml` (raíz) y `server/bunfig.toml`: declaran los mismos `preload` de test con rutas relativas distintas (Bun lee bunfig solo del CWD). `server/tests/bunfig-preload.test.ts` verifica que no diverjan: si añades preload, cámbialo en **ambos**.
- `app/tests/preload.ts` y `server/scripts/test-preload.ts` hacen el grafo determinista; borrarlos rompe tests en silencio.
- `bridge/state.json`: estado vivo del puente (chatId, channelUrl, `vistosTextos` anti-duplicados, `correosCuentas`, `podaPendiente`). No reiniciarlo a un `{}` vacío: puede reenviar mensajes viejos a Telegram. El puente nunca repite textos ya retransmitidos — preservar esa deduplicación en cualquier cambio.

## Puente Telegram (solo local)

- `bridge/telegram-bridge.ts`: long-polling → escribe en el canal del Orquestador vía navegador headless (Playwright, `playwright-core`); retransmite respuestas nuevas a Telegram. Voz → whisper en Groq (`TRANSCRIPTION_*` del `.env`); imagen → aviso (no soportada aún).
- Comandos que implementa: `/sesiones`, `/ir <id>`, `/novedades`, `/poda` (con confirmación `/poda SÍ`, nunca borra la sesión activa — borrado suave `DELETE /api/channels/:id`), `/new`, `/refresca`, `/help`.
- Si cambias el puente: recompila con `bun build --no-bundle` antes de relanzar; el log está en `.logs/telegram-bridge.log` con timestamps **UTC** (hora local aquí = UTC−6).
- Bandeja bot-a-bot `../bandeja/` (A2A sin chat): el puente reclama `*.tarea.json` con `para: "opencode"` cada 30 s (ignora las que traen `destino`: esas las toma una sesión viva vía MCP), corre `opencode run --format json` headless en `LaboratorioREA` (o en `dir` si viene dentro de `Base/`) y escribe `*.resultado.json` con `sesion` (ver `bandeja/README.md`). Pausa con `vigilancia.off` o fuera de `BANDEJA_HORARIO`/`BANDEJA_DIAS`. Requiere **opencode v2** global (`bun install --global @opencode/cli` + `bun pm -g trust @opencode/cli`; v1 no abre la DB que v2 migró). `OPENCODE_BIN` apunta al binario real (`.../node_modules/@opencode/cli/bin/opencode.exe`); el spawn lleva `stdin: "ignore"` (heredarlo bloquea al hijo en detached) y el `cwd` es `../../../LaboratorioREA` (no `../../`). Si reinicias el puente a mano, el supervisor puede crear un duplicado breve: él mismo lo reduce a uno ("hay 2 puentes; dejo uno").

## Entorno Windows / supervisor local

- Arranque de un clic: `start-openbot.cmd` (Docker → `scripts/openbot-supervisor.ps1` → espera app → abre navegador). Supervisor: vigila Docker/contenedores/server/worker/app y el puente aparte (respawn por latido de log >15 min); reconcilia delegando en `start.sh` (backoff 45 s → 900 s). `-Once` para depurar una sola pasada.
- Para apagar: `cierra-openbot.cmd` (crea `.logs/supervisor.stop` que el supervisor y el autoarranque respetan). Autoarranque de sesión vía `Inicio\OpenBot.cmd` → `scripts/openbot-autostart.cmd`.
- PowerShell 5.1 (la base aquí): los `.ps1` **sin acentos/emojis** (ASCII puro) y **sin `??` ni `?.`** (no soportados); `Start-Process` devuelve ExitCode vacío — usar `Invoke-Native`/patrón del supervisor para códigos reales. Line endings CRLF en `.cmd`/`.ps1`.
- `start-openbot.cmd` anula globales (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, etc.) para que no pisen el `.env` — si agregas una var con nombre común, borrarla ahí también.
- Git Bash es obligatorio para `start.sh`/`stop.sh` (`C:\Program Files\Git\bin\bash.exe`); el supervisor ya lo inyecta en PATH.

## Secretos y configuración

- `.env` **no va a git** (está ignorado); aquí además contiene llaves operativas en texto plano temporalmente. Las llaves canónicas viven en la bóveda KeePass `ci.kdbx` del Escritorio (grupo `OpenBot`) — al tocar secretos, mantener bóveda como fuente y/o rotar lo que haya pegado en chat.
- Secretos de Supabase (`CORREO_CRON_SECRET`, tokens GHL) viven en Supabase → Edge Functions → Secrets, **no** en código ni en este repo.
- `prompt.txt` es el onboarding verificado del upstream para asistentes (setup paso a paso con lo fácil de equivocarse). `docs/` cubre deployment, configuración y arquitectura; `docs/development.md` es la referencia de setup/migraciones/tests.

## Skills de este repo (leer antes de tocar app/)

- `.claude/skills/openbot-data-access/SKILL.md`: todo fetch del navegador va por `app/src/lib/client.ts`; lecturas en `app/src/lib/<entity>/queries.ts`, escrituras en `mutations.ts`. Nunca introducir `fetch` fuera de `client.ts` bajo `app/src`.
- `.claude/skills/openbot-screen-layout/SKILL.md`: layout de pantallas (PageShell/PageSection, settings-row, diálogos) — paridad visual con lo que ya existe en `app/src/routes`.

## Mapa de `Base/` (carpetas hermanas que sí se usan)

Fuente de verdad: `..\..\ORQUESTADOR.md` (inventario, reglas de oro, estado de servicios). Léelo al empezar misiones multi-proyecto y actualízalo al cerrarlas.

- **Fuente canónica = `repos\*`**. `repos\straight-shot-art` = cotizador y dueño del esquema Supabase; `repos\crm-irs` = CRM, sin DDL. Copias de trabajo en `trabajo\` (`cotizador-irs` sin git, `crm-irs`, clon local `recursos\obsoletos\straight-shot-art` atrasado y fuera de uso).
- **`microsip\Pmicrosp\`** = fork REA + `mvp-contable/` (proyecto npm aparte: sus comandos se corren desde esa carpeta; Next 16). `docs/microsip/` y `PROMPT-SESION.md` son material local sin commit. Microsip es solo-lectura: no instalar/ejecutar/modificar nada ni abrir su Firebird; solo datos sintéticos. Es el destino del módulo `/oc` del puente.
- **`plataforma\codepath\`** = motor Rust de búsqueda semántica + MCP local; Qdrant :6333, API :3000 (`ai_platform.exe`, suele estar abajo → `codepath_*` no responde). Reindexar con `reindexar-crm.ps1` tras cambios grandes. El puerto 3000 lo pelean esa API y `mvp-contable`: si está ocupado, `npm run dev -- -p 3100`.
- **`recursos\deploy-correo\`** = paquete de 2 funciones Supabase (`correo-enviar`, `correo-inbound`); desactualizado frente a las 7 del repo canónico; se publica con `conectar-y-publicar.bat`.
- **`recursos\sql-para-dueno\`** = SQL que **solo el dueño del esquema aplica** (`01_...oc...` activa la UI de OC del CRM, `02_conversaciones_email` + `02b_` el correo nativo); orden y revisiones previas en su README. Nada de esto se aplica desde el CRM.
- **`recursos\sandbox-migrations\`** = espejo/reconstrucción del esquema para pruebas; **nunca apuntar a producción**.
- **`recursos\backup-lab\`** = documentación (`MAPEO-CRM.md`, `LABORATORIO-CODEPATH.md`) y secretos (`*.env`, `sandbox-qa-credenciales.txt`): **no commitear, no pegar en prompts/issues**.
- **`trabajo\cotazion\`** = pipeline DWG→DXF→PDF acotado (`pipeline.py`, `run.bat`, `input/` → `output*/`); requiere Python 3.10+ y ODA File Converter; independiente del resto.
- **`recursos\figuras\crm-correo\`** = diagramas isométricos del módulo de correo. **`recursos\tools\nasm-3.02\`** = NASM portable para compilar CodePath. Los `.zip` de `recursos\zips\` son snapshots congelados: no descomprimir sobre árboles de trabajo.

## Convenciones y notas operativas

- Biome se encarga de formateo y lint (aquí no hay Prettier/ESLint): `bun run format` antes de commit grande; `biome.json` define overrides y archivos ignorados.
- Versión de Bun: **1.4.3** (`packageManager`). No usar `npm`/`yarn`; el lockfile es `bun.lock`.
- `CHANGELOG.md` es del upstream y enorme — no lo uses como fuente activa de decisiones; verifica en el código.
- `registros/` (Obsidian) es el diario y preferencias del usuario (mapa de proyectos, pendientes, recordatorios) — es documentación viva del operador local; úsala para contexto de decisiones y **no** la pongas en un PR upstream.
- Lógica de identidad/usuario único: `OPENBOT_SINGLE_USER=true` admite cualquiera como admin — jamás exponer el puerto 3010 fuera de localhost con esa variable activa.
