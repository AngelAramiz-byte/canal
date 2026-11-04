import { Hono } from "hono";
import { createCanalRoutes } from "./routes";
import { cargarSecretos } from "./infisical";

/**
 * Entrada del servicio slim (Render free): solo el canal bot-a-bot.
 * Sin app, sin navegador, sin postgres embebido.
 * Secretos: env directo o Infisical (fallback); la BD es Supabase.
 * Escucha en 0.0.0.0:$PORT (inyectado por Render).
 */

const sec = await cargarSecretos();

const app = new Hono();
app.get("/", (context) => context.redirect("/telarana"));
app.get("/health", (context) =>
  context.json({ status: "ok", servicio: "canal" }),
);
app.route(
  "/",
  createCanalRoutes({
    bootstrap: sec.bootstrap,
    databaseUrl: sec.databaseUrl,
  }),
);

const port = Number(process.env.PORT ?? "3001") || 3001;
export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
