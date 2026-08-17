/**
 * Model resolution for the agent.
 *
 * pi-ai ships catalogs for many providers, but only DeepSeek is registered
 * here: a smaller catalog means a smaller failure surface and no unrelated
 * provider SDKs pulled in at runtime.
 */

import { createModels, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";

export const PROVIDER_ID = "deepseek";

export type ModelBinding = {
  readonly models: MutableModels;
  readonly model: Model<Api>;
};

export type ModelResolution =
  | { readonly ok: true; readonly binding: ModelBinding }
  | { readonly ok: false; readonly available: readonly string[] };

/**
 * Looks the configured model up in the DeepSeek catalog. An unknown id is a
 * configuration error, so the failure carries the valid ids for the log.
 */
export const resolveModel = (modelId: string): ModelResolution => {
  const models = createModels();
  models.setProvider(deepseekProvider());

  const model = models.getModel(PROVIDER_ID, modelId);
  if (model === undefined) {
    return { ok: false, available: models.getModels(PROVIDER_ID).map((m) => m.id) };
  }
  return { ok: true, binding: { models, model } };
};
