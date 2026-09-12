import type { Request, Response } from "express";
import type { Store } from "../store/store.js";
import type { GridEvent } from "../types.js";

export const sseHandler = (store: Store) => (req: Request, res: Response) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event: string, data: unknown) => {
    if (res.destroyed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send("snapshot", store.getState());
  const onEvent = (e: GridEvent) => send("change", e);
  store.on("event", onEvent);
  const ping = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n"); }, 25_000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(ping);
    store.off("event", onEvent);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("close", cleanup);
};
