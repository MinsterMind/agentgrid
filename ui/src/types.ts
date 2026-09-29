export type * from "../../server/src/types.js";
export type * from "../../server/src/bugfix/types.js";
export type { Integrations } from "../../server/src/bugfix/integrations.js";
export type { CheckId, Check, SetupReport } from "../../server/src/bugfix/setup.js";
import type { SetupReport } from "../../server/src/bugfix/setup.js";
/** The server does not name this shape on its own — it's inline on `SetupReport.discovery.importable`. */
export type DiscoveredServer = SetupReport["discovery"]["importable"][number];
