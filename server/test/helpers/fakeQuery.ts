import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/runner.js";

export function makeFakeQuery() {
  const calls: Array<{ prompt: string; options: Options }> = [];
  const queue: Array<{ msg?: SDKMessage; end?: true; err?: Error }> = [];
  let wake: (() => void) | null = null;
  const push = (item: { msg?: SDKMessage; end?: true; err?: Error }) => { queue.push(item); wake?.(); wake = null; };

  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const signal = options.abortController?.signal;
    async function* gen(): AsyncGenerator<SDKMessage> {
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const item = queue.shift();
        if (!item) { await new Promise<void>(r => { wake = r; signal?.addEventListener("abort", () => r(), { once: true }); }); continue; }
        if (item.err) throw item.err;
        if (item.end) return;
        yield item.msg!;
      }
    }
    return gen();
  };
  return {
    queryFn, calls,
    emit: (msg: SDKMessage) => push({ msg }),
    end: () => push({ end: true }),
    fail: (err: Error) => push({ err }),
  };
}

// message factories (only the fields the runner reads)
export const init = (session_id: string) => ({ type: "system", subtype: "init", session_id } as unknown as SDKMessage);
export const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } } as unknown as SDKMessage);
export const toolUse = (name: string, input: Record<string, unknown>) =>
  ({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu", name, input }] } } as unknown as SDKMessage);
export const success = (result: string, cost = 0.5, turns = 3, session_id = "s1") =>
  ({ type: "result", subtype: "success", result, total_cost_usd: cost, num_turns: turns, duration_ms: 10, session_id, is_error: false } as unknown as SDKMessage);
export const errorResult = (subtype: string, cost = 0.1, turns = 1) =>
  ({ type: "result", subtype, total_cost_usd: cost, num_turns: turns, duration_ms: 10, is_error: true } as unknown as SDKMessage);
