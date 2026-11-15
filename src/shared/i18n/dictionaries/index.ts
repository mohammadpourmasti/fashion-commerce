import type { Locale } from "../config";
import type { Dictionary } from "./en";
import en from "./en";
import fa from "./fa";

export type { Dictionary };

/**
 * Static map so client error boundaries (which cannot use server-only
 * loaders) can also resolve copy. Dictionaries are small; split per route
 * group with dynamic imports once they grow.
 */
export const dictionaries: Record<Locale, Dictionary> = { en, fa };
