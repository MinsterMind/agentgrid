import os from "node:os";
import path from "node:path";

export function resolveHome(): string {
  return process.env.AGENTGRID_HOME ?? path.join(os.homedir(), ".agentgrid");
}

export function paths(home: string) {
  return {
    home,
    roles: path.join(home, "roles"),
    agents: path.join(home, "agents"),
    archived: path.join(home, "agents", "_archived"),
    assignments: path.join(home, "assignments"),
    agentDir: (id: string) => path.join(home, "agents", id),
    agentFile: (id: string) => path.join(home, "agents", `${id}.json`),
    memoryDir: (id: string) => path.join(home, "agents", id, "memory"),
    assignmentFile: (id: string) => path.join(home, "assignments", `${id}.json`),
  };
}
