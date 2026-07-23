import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"

export interface JsonSnapshotError {
  readonly _tag: "JsonSnapshotError"
  readonly message: string
  readonly path: ReadonlyArray<string | number>
}

interface EnterTask {
  readonly _tag: "Enter"
  readonly value: unknown
  readonly path: Path
  readonly depth: number
  readonly assign: (value: Schema.Json) => void
}

interface ExitTask {
  readonly _tag: "Exit"
  readonly source: object
  readonly output: ReadonlyArray<Schema.Json> | Schema.JsonObject
}

type Task = EnterTask | ExitTask

interface PathNode {
  readonly parent: Path
  readonly key: string | number
}

type Path = PathNode | undefined

const childPath = (parent: Path, key: string | number): PathNode => ({ parent, key })

const failure = (
  message: string,
  path: Path
): Result.Result<never, JsonSnapshotError> => {
  const parts: Array<string | number> = []
  let current = path
  while (current !== undefined) {
    parts.push(current.key)
    current = current.parent
  }
  parts.reverse()
  return Result.fail({ _tag: "JsonSnapshotError", message, path: Object.freeze(parts) })
}

const isArrayIndex = (key: string, length: number): boolean => {
  if (key === "" || key === "0") {
    return key === "0" && length > 0
  }
  const first = key.charCodeAt(0)
  if (first < 49 || first > 57) {
    return false
  }
  const index = Number(key)
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key
}

const define = (
  target: object,
  key: string,
  value: Schema.Json
): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true
  })
}

export interface SnapshotLimits {
  readonly maxArrayLength?: number
  readonly maxContainers?: number
  readonly maxDepth?: number
  readonly maxEntries?: number
  readonly maxStringBytes?: number
  readonly maxTotalBytes?: number
}

const DefaultSnapshotLimits: Required<SnapshotLimits> = Object.freeze({
  maxArrayLength: 65_536,
  maxContainers: 16_384,
  maxDepth: 16_384,
  maxEntries: 131_072,
  maxStringBytes: 8 * 1_024 * 1_024,
  maxTotalBytes: 16 * 1_024 * 1_024
})

const encodedStringBytes = (
  value: string,
  limit: number
): number | undefined => {
  let bytes = 2
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (
      code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 ||
      code === 0x0a || code === 0x0c || code === 0x0d
    ) {
      bytes += 2
    } else if (code <= 0x1f) {
      bytes += 6
    } else if (code <= 0x7f) {
      bytes++
    } else if (code <= 0x7ff) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else {
        bytes += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6
    } else {
      bytes += 3
    }
    if (bytes > limit) {
      return undefined
    }
  }
  return bytes
}

/** Creates a detached, recursively frozen strict-JSON snapshot. */
export const snapshot = (
  input: unknown,
  limits: SnapshotLimits = {}
): Result.Result<Schema.Json, JsonSnapshotError> => {
  let root: Schema.Json = null
  let currentPath: Path
  let containerCount = 0
  let entryCount = 0
  let encodedBytes = 0
  const maxArrayLength = limits.maxArrayLength ?? DefaultSnapshotLimits.maxArrayLength
  const maxContainers = limits.maxContainers ?? DefaultSnapshotLimits.maxContainers
  const maxDepth = limits.maxDepth ?? DefaultSnapshotLimits.maxDepth
  const maxEntries = limits.maxEntries ?? DefaultSnapshotLimits.maxEntries
  const maxStringBytes = limits.maxStringBytes ?? DefaultSnapshotLimits.maxStringBytes
  const maxTotalBytes = limits.maxTotalBytes ?? DefaultSnapshotLimits.maxTotalBytes
  const ancestors = new WeakSet<object>()
  const tasks: Array<Task> = [{
    _tag: "Enter",
    value: input,
    path: undefined,
    depth: 0,
    assign: (value) => {
      root = value
    }
  }]

  try {
    while (tasks.length > 0) {
      const task = tasks.pop()!
      if (task._tag === "Exit") {
        Object.freeze(task.output)
        ancestors.delete(task.source)
        continue
      }

      currentPath = task.path
      const value = task.value
      if (value === null) {
        encodedBytes += 4
        if (encodedBytes > maxTotalBytes) {
          return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
        }
        task.assign(value)
        continue
      }
      if (typeof value === "string") {
        const bytes = encodedStringBytes(value, maxStringBytes)
        if (bytes === undefined) {
          return failure(`Encoded JSON string exceeds ${maxStringBytes} bytes`, task.path)
        }
        encodedBytes += bytes
        if (encodedBytes > maxTotalBytes) {
          return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
        }
        task.assign(value)
        continue
      }
      if (typeof value === "boolean") {
        encodedBytes += value ? 4 : 5
        if (encodedBytes > maxTotalBytes) {
          return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
        }
        task.assign(value)
        continue
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) {
          return failure("JSON numbers must be finite", task.path)
        }
        encodedBytes += JSON.stringify(value).length
        if (encodedBytes > maxTotalBytes) {
          return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
        }
        task.assign(Object.is(value, -0) ? 0 : value)
        continue
      }
      if (typeof value !== "object") {
        return failure(`Unsupported JSON value of type '${typeof value}'`, task.path)
      }
      if (task.depth > maxDepth) {
        return failure(`JSON nesting exceeds ${maxDepth}`, task.path)
      }
      if (ancestors.has(value)) {
        return failure("Cyclic JSON values are not supported", task.path)
      }

      const isArray = Array.isArray(value)
      const prototype = Object.getPrototypeOf(value)
      if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
        return failure("JSON containers must be plain objects or arrays", task.path)
      }
      containerCount++
      if (containerCount > maxContainers) {
        return failure(`JSON container count exceeds ${maxContainers}`, task.path)
      }
      if (isArray) {
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
        const length = lengthDescriptor?.value
        if (
          lengthDescriptor === undefined || "get" in lengthDescriptor ||
          typeof length !== "number" || !Number.isInteger(length) || length < 0
        ) {
          return failure("JSON arrays must have a valid data length", task.path)
        }
        if (length > maxArrayLength) {
          return failure(`JSON array length exceeds ${maxArrayLength}`, task.path)
        }
        encodedBytes += 2 + Math.max(0, length - 1)
        if (encodedBytes > maxTotalBytes) {
          return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
        }
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const keys = Reflect.ownKeys(descriptors)

      if (isArray) {
        const lengthDescriptor = descriptors.length
        const length = lengthDescriptor?.value
        if (
          lengthDescriptor === undefined || "get" in lengthDescriptor ||
          typeof length !== "number" || !Number.isInteger(length) || length < 0 ||
          keys.length !== length + 1
        ) {
          return failure("JSON arrays must be dense and contain only indexed elements", task.path)
        }
        entryCount += length
        if (entryCount > maxEntries) {
          return failure(`JSON entry count exceeds ${maxEntries}`, task.path)
        }
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]!
          if (typeof key === "symbol") {
            return failure("JSON arrays cannot contain symbol properties", task.path)
          }
          if (key === "length") {
            continue
          }
          const descriptor = descriptors[key]!
          if (!isArrayIndex(key, length) || "get" in descriptor || !descriptor.enumerable) {
            return failure("JSON arrays must be dense and contain only indexed data properties", task.path)
          }
        }

        const output = new Array<Schema.Json>(length)
        task.assign(output)
        ancestors.add(value)
        tasks.push({ _tag: "Exit", source: value, output })
        for (let index = length - 1; index >= 0; index--) {
          const descriptor = descriptors[String(index)]!
          tasks.push({
            _tag: "Enter",
            value: descriptor.value,
            path: childPath(task.path, index),
            depth: task.depth + 1,
            assign: (child) => define(output, String(index), child)
          })
        }
        continue
      }

      const entries: Array<readonly [string, PropertyDescriptor]> = []
      entryCount += keys.length
      if (entryCount > maxEntries) {
        return failure(`JSON entry count exceeds ${maxEntries}`, task.path)
      }
      encodedBytes += 2 + Math.max(0, keys.length - 1) + keys.length
      if (encodedBytes > maxTotalBytes) {
        return failure(`Encoded JSON size exceeds ${maxTotalBytes} bytes`, task.path)
      }
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!
        if (typeof key === "symbol") {
          return failure("JSON objects cannot contain symbol properties", task.path)
        }
        const keyBytes = encodedStringBytes(key, maxStringBytes)
        if (keyBytes === undefined) {
          return failure(
            `Encoded JSON property name exceeds ${maxStringBytes} bytes`,
            childPath(task.path, key)
          )
        }
        encodedBytes += keyBytes
        if (encodedBytes > maxTotalBytes) {
          return failure(
            `Encoded JSON size exceeds ${maxTotalBytes} bytes`,
            childPath(task.path, key)
          )
        }
        const descriptor = descriptors[key]!
        if ("get" in descriptor || !descriptor.enumerable) {
          return failure(
            "JSON objects must contain only enumerable data properties",
            childPath(task.path, key)
          )
        }
        entries.push([key, descriptor])
      }

      const output: Schema.JsonObject = {}
      task.assign(output)
      ancestors.add(value)
      tasks.push({ _tag: "Exit", source: value, output })
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, descriptor] = entries[index]!
        tasks.push({
          _tag: "Enter",
          value: descriptor.value,
          path: childPath(task.path, key),
          depth: task.depth + 1,
          assign: (child) => define(output, key, child)
        })
      }
    }
  } catch {
    return failure("JSON value could not be inspected safely", currentPath)
  }

  return Result.succeed(root)
}

/** Canonicalizes a snapshot without recursion or container instance methods. */
export const canonicalizeSnapshot = (value: Schema.Json): string => {
  const output: Array<string> = []
  type CanonicalTask = { readonly _tag: "Value"; readonly value: Schema.Json } | {
    readonly _tag: "Text"
    readonly value: string
  }
  const tasks: Array<CanonicalTask> = [{ _tag: "Value", value }]
  const text = (value: string): CanonicalTask => ({ _tag: "Text", value })
  const json = (value: Schema.Json): CanonicalTask => ({ _tag: "Value", value })
  while (tasks.length > 0) {
    const task = tasks.pop()!
    if (task._tag === "Text") {
      output.push(task.value)
      continue
    }
    const current = task.value
    if (
      current === null || typeof current === "boolean" || typeof current === "number" ||
      typeof current === "string"
    ) {
      output.push(JSON.stringify(current))
      continue
    }
    if (Array.isArray(current)) {
      tasks.push(text("]"))
      for (let index = current.length - 1; index >= 0; index--) {
        tasks.push(json(current[index]!))
        if (index > 0) tasks.push(text(","))
      }
      tasks.push(text("["))
      continue
    }
    const object = current as Schema.JsonObject
    const keys = Object.keys(object).sort()
    tasks.push(text("}"))
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!
      tasks.push(json(object[key]!))
      tasks.push(text(":"))
      tasks.push(text(JSON.stringify(key)))
      if (index > 0) tasks.push(text(","))
    }
    tasks.push(text("{"))
  }
  return output.join("")
}

/** Snapshots and canonicalizes an unknown strict-JSON value. */
export const canonicalize = (input: unknown): Result.Result<string, JsonSnapshotError> => {
  const snapped = snapshot(input)
  return Result.isFailure(snapped)
    ? Result.fail(snapped.failure)
    : Result.succeed(canonicalizeSnapshot(snapped.success))
}
