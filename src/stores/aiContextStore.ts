import { createSignal } from "solid-js";

const [sqlContext, setSQLContext] = createSignal("");

/** Context published by the active database workspace for the SQL Agent. */
export const aiContextStore = {
  sqlContext,
  setSQLContext,
};
