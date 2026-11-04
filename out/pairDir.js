"use strict";
// ---------------------------------------------------------------------------
// Working out the folder when two files are dropped at once
// Two files dropped together come from the same folder.
// So the folder that holds both of them (same name, same size)
// is where a save has to go — no dialog full of same-named files.
// Pure functions, no vscode dependency, easy to unit test.
// ---------------------------------------------------------------------------
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickPairHit = pickPairHit;
/**
 * @param la every "same name + same size" candidate for file A
 * @param lb every "same name + same size" candidate for file B
 * @returns the one folder holding both, with the matching entry on each side;
 *          null when there is none, or more than one
 */
function pickPairHit(la, lb) {
    if (!la.length || !lb.length)
        return null;
    const dirsB = new Map(lb.map(x => [x.dir.toLowerCase(), x]));
    const common = la.filter(x => dirsB.has(x.dir.toLowerCase()));
    if (common.length !== 1)
        return null;
    const a = common[0];
    return { a, b: dirsB.get(a.dir.toLowerCase()) };
}
//# sourceMappingURL=pairDir.js.map