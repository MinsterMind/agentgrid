import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../../src/runner/runner.js";

type Item = { msg?: SDKMessage; end?: true; err?: Error };
interface Stream { queue: Item[]; wake: (() => void) | null }

/**
 * A real SDK query() call returns a fresh stream every time it's invoked; nothing about
 * one call's stream is shared with the next. Earlier this helper modeled that with a
 * single queue shared across every queryFn() invocation, which meant a stray end() left
 * behind by one stage's stream (Runner.consume() returns as soon as it sees a "result"
 * message, so it never drains an end() queued after it) became the *first* item the next
 * stage's stream saw — a stream that then looked like it had ended with no result at
 * all. Each call now gets its own isolated queue, matching the real SDK; emit()/end()/
 * fail() always target the most recently started stream, which is what every test's
 * sequential assign-then-finish usage expects.
 */
export function makeFakeQuery() {
  const calls: Array<{ prompt: string; options: Options }> = [];
  let current: Stream | null = null;

  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    const stream: Stream = { queue: [], wake: null };
    current = stream;
    const signal = options.abortController?.signal;
    async function* gen(): AsyncGenerator<SDKMessage> {
      while (true) {
        if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const item = stream.queue.shift();
        if (!item) { await new Promise<void>(r => { stream.wake = r; signal?.addEventListener("abort", () => r(), { once: true }); }); continue; }
        if (item.err) throw item.err;
        if (item.end) return;
        yield item.msg!;
      }
    }
    return gen();
  };

  const push = (item: Item) => {
    if (!current) throw new Error("makeFakeQuery: emit()/end()/fail() called before any query started");
    current.queue.push(item);
    current.wake?.();
    current.wake = null;
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
