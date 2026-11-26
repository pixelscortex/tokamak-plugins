import type { Tool } from "../../contracts";
import { commandIcon, editIcon, fileIcon, searchIcon, toolIcon, webIcon } from "./icons";

/** Per kind of tool: the running line's verb ("Running pnpm test auth") and the step row's icon. */
export const kinds: Readonly<Record<Tool["kind"], { verb: string; icon: string }>> = {
  command: { verb: "Running", icon: commandIcon },
  read: { verb: "Reading", icon: fileIcon },
  edit: { verb: "Editing", icon: editIcon },
  search: { verb: "Searching", icon: searchIcon },
  web: { verb: "Fetching", icon: webIcon },
  other: { verb: "Using", icon: toolIcon },
};
