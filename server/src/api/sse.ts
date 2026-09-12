import type { Request, Response } from "express";
import type { Store } from "../store/store.js";
import type { GridEvent } from "../types.js";

export const sseHandler = (store: Store) => (req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("snapshot", store.getState());
  const onEvent = (e: GridEvent) => send("change", e);
  store.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); store.off("event", onEvent); });
};
