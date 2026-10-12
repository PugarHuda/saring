// Only used by the Arcium client's circuit uploader, which the browser never calls.
export function readFileSync(): never {
  throw new Error("fs is not available in the browser");
}
export default { readFileSync };
