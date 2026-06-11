import type { Provider } from "./provider.js";
import type { ProviderName } from "./types.js";
import { codexProvider } from "./codex.js";
import { claudeCodeProvider } from "./claude_code.js";

const providers: Record<string, Provider> = {
  codex: codexProvider,
  claude_code: claudeCodeProvider,
};

export function getProvider(name: ProviderName): Provider {
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
  }
  return provider;
}

export { codexProvider, claudeCodeProvider };
export type { Provider } from "./provider.js";
export type { ProviderName, ProviderSettings, WorkOrderInput, BuilderResult, ReviewVerdict } from "./types.js";
