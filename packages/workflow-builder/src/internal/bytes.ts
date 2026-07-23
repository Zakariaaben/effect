const TypedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype
) as object

const byteLengthGetter = Object.getOwnPropertyDescriptor(
  TypedArrayPrototype,
  "byteLength"
)?.get

if (byteLengthGetter === undefined) {
  throw new Error("Uint8Array byteLength intrinsic is unavailable")
}

/**
 * Copies bytes without consulting an input subclass's iterator, methods, or
 * `Symbol.species`.
 */
export const copyUint8Array = (input: unknown): Uint8Array => {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("Input is not a Uint8Array")
  }
  const byteLength = byteLengthGetter.call(input) as number
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError("Uint8Array byte length is invalid")
  }
  const output = new Uint8Array(byteLength)
  Uint8Array.prototype.set.call(output, input)
  return output
}
