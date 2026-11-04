"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_VERSION = void 0;
exports.stampVersion = stampVersion;
/**
 * Version shown in the tool panels (title bar chips, About dialogs, webview-side APP_VER).
 *
 * This is the TOOLS' own UI version — deliberately independent of the extension
 * package version in package.json. The extension can ship as 0.1.x while the
 * four tools stay at 1.0, exactly like a product whose bundled tools have
 * their own version line. If a tool's UI ever changes on its own schedule,
 * bump TOOL_VERSION by hand; it never tracks the manifest again.
 */
exports.TOOL_VERSION = '1.0';
/** Fill the __BB_VER__ token (title bar chips, About dialog, webview-side APP_VER) */
function stampVersion(html) {
    return html.replace(/__BB_VER__/g, exports.TOOL_VERSION);
}
//# sourceMappingURL=version.js.map