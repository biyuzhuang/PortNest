import { createSignal } from "solid-js";

type AgentLaunchMode = "general" | "terminal" | "sql";

const [sqlContext, setSQLContext] = createSignal("");
const [sqlSelection, setSQLSelection] = createSignal("");
const sqlDraftAppliers = new Set<(sql: string) => boolean>();
let agentLauncher: ((mode: AgentLaunchMode) => void) | undefined;

/** Context and editor actions published by the active workspace. */
export const aiContextStore = {
  sqlContext,
  setSQLContext,
  sqlSelection,
  setSQLSelection,
  registerSQLDraftApplier(applier: (sql: string) => boolean) {
    sqlDraftAppliers.add(applier);
    return () => {
      sqlDraftAppliers.delete(applier);
    };
  },
  applySQLDraft(sql: string): boolean {
    for (const applier of sqlDraftAppliers) {
      if (applier(sql)) return true;
    }
    return false;
  },
  registerAgentLauncher(launcher: (mode: AgentLaunchMode) => void) {
    agentLauncher = launcher;
    return () => {
      if (agentLauncher === launcher) agentLauncher = undefined;
    };
  },
  openAgent(mode: AgentLaunchMode = "general") {
    agentLauncher?.(mode);
  },
};
