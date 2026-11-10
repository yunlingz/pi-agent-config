import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCacheRate } from "./cache-rate.ts";

export default function (pi: ExtensionAPI) {
  registerCacheRate(pi);
}
