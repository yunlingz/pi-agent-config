import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTokenUsage } from "./token-usage.ts";

export default function (pi: ExtensionAPI): void {
  registerTokenUsage(pi);
}
