import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tokamakDir } from "../../support/paths.mjs";

// Shell and plugin captures use the same drawn tree for Paper.
const capture = pathToFileURL(join(tokamakDir, "e2e/browser/screen-capture.ts"));
export const { out, screen, shot } = await import(capture.href);
