import type { Request, Response } from "express";
import type { Store } from "../store/store.js";
export const sseHandler = (_store: Store) => (_req: Request, res: Response) => { res.status(501).end(); };
