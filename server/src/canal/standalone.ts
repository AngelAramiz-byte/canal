import { Hono } from "hono";
import { createCanalRoutes } from "./routes";

/**
 * Entrada del servicio slim (Render free): solo el canal bot-a-bot.
 * Sin app, sin navegador, sin postgres embebido: la BD es Supabase.
 * Escucha en 0.0.0.0:$PORT (inyectado por Render).
 */

const app = new Hono();
app.get("/health", (context) =>
  context.json({ status: "ok", servicio: "canal" }),
);
app.route(
  "/",
  createCanalRoutes({
    bootstrap: process.env.CANAL_BOOTSTRAP,
    databaseUrl: process.env.CANAL_DATABASE_URL,
  }),
);

const port = Number(process.env.PORT ?? "3001") || 3001;
export default {
  port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
