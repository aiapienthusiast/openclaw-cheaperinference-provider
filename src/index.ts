import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import { buildModelCatalogProvider, buildProvider } from "./provider.js";

export default definePluginEntry({
  id: PROVIDER_ID,
  name: PROVIDER_LABEL,
  description: "Cheaper Inference model provider (OpenAI-compatible API)",
  register(api) {
    api.registerProvider(buildProvider());
    api.registerModelCatalogProvider(buildModelCatalogProvider());
  },
});
