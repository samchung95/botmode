// Hands pi's own TUI to botmode.mjs, which draws bots' messages in their colours. pi gives an extension its copies of these
// only through static imports, and botmode.mjs must load without pi too, for its tests and the botmode command.
import * as tui from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

globalThis[Symbol.for("botmode.tui")] = { ...tui, getMarkdownTheme };

export default function () {}
