import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BugLauncher } from "./BugLauncher";
import { api } from "../api";

beforeEach(() => vi.restoreAllMocks());

describe("BugLauncher when setup is incomplete", () => {
  it("names the blocking checks and offers Settings instead of a bare 501", async () => {
    vi.spyOn(api, "getSetup").mockResolvedValue({
      ready: false, wired: false, addCommand: "",
      checks: [
        { id: "tracker", state: "missing", detail: "No tracker configured.", blocks: true },
        { id: "forge-token", state: "missing", detail: "BITBUCKET_API_TOKEN is not visible to the server process.", blocks: false },
      ],
      discovery: { servers: [], problems: [] },
    });
    render(<BugLauncher onClose={() => {}} onOpenSettings={() => {}} />);
    expect(await screen.findByText(/No tracker configured/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /settings/i })).toBeTruthy();
    // A non-blocking check must not nag while something else is still blocking.
    expect(screen.queryByText(/BITBUCKET_API_TOKEN/)).toBeNull();
  });
});
