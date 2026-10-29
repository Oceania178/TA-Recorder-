// P7: the recorder windows never talk to the network. Only the app's own files (inside the renderer folder,
// APP review M10) and in-memory data load. The rule lives in pagePolicy.ts.
export { isAllowedRendererRequest } from "./pagePolicy";
