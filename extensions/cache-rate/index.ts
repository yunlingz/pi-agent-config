import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCacheRate } from "./cache-rate.mjs";

export default function (pi: ExtensionAPI) {
  registerCacheRate(pi);
}
