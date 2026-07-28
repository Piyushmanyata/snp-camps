/**
 * Empty stand-in for a Node built-in requested from browser code.
 *
 * Only OpenCV needs this. Its Emscripten build carries both a Node and a
 * browser bootstrap in one file and does `require("fs")` inside the Node
 * branch — a branch that never executes in a browser, but which the bundler
 * still has to resolve. Aliasing `fs` to nothing silences the resolve without
 * changing any behaviour we rely on.
 *
 * Do not reach for this to quiet other Node imports: anywhere else, a browser
 * bundle pulling in `fs` is a real layering bug and must be fixed at the import.
 */
export default {};
