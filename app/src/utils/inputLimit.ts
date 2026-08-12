/** Server rejects session input over this many bytes (see send_input in src/model/session.rs) */
export const INPUT_MAX_BYTES = 10_000;

/** Byte length of text as the server measures it (UTF-8) */
export function inputBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}
