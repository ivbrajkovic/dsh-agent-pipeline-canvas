// Stylesheet imports in the client source are handled by the build's
// pipeline-css-inline loader (see tsdown.config.ts): each sheet compiles into
// a tagged <style data-plugin-css> injector at factory materialization. This
// ambient declaration lets the whole-tree typecheck accept the imports.
declare module "*.css";
