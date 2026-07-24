/**
 * Optional native `DurableQueue` transport for protocol-version `3` node
 * attempts.
 *
 * **Details**
 *
 * This adapter delegates persisted queue storage, delivery, redelivery,
 * worker supervision, durable waiting, and workflow resumption to Effect's
 * native workflow and persistence modules. It owns no queue store, lease,
 * heartbeat, scheduler, journal, sharding, or failover implementation.
 *
 * A workflow still persists the authoritative node-attempt outcome through
 * the same native semantic `Activity` as the direct backend. The remote worker
 * returns only a strictly encoded handler result; it cannot manufacture a
 * timeout or canonical completion timestamp.
 *
 * @since 4.0.0
 */
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import type * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import type * as PersistedQueue from "effect/unstable/persistence/PersistedQueue"
import * as NativeDurableQueue from "effect/unstable/workflow/DurableQueue"
import type * as NativeWorkflowEngine from "effect/unstable/workflow/WorkflowEngine"
import * as DigestV3 from "./DigestV3.ts"
import type * as EffectWorkflowRetryV3 from "./EffectWorkflowRetryV3.ts"
import * as EffectWorkflowSemanticV3 from "./EffectWorkflowSemanticV3.ts"
import * as Identity from "./Identity.ts"
import * as PlanStoreV3 from "./PlanStoreV3.ts"
import * as Wire from "./ProtocolV3Wire.ts"
import * as SemanticExecutableRegistryV3 from "./SemanticExecutableRegistryV3.ts"
import * as SemanticOperationV3 from "./SemanticOperationV3.ts"

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error"
} as const

const preparedRoutes = new WeakMap<
  object,
  NativeNodeAttemptQueue
>()

/**
 * Independent format version of this adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const AdapterVersion = 1 as const

/**
 * Execution protocol hosted by this adapter.
 *
 * @category constants
 * @since 4.0.0
 */
export const ExecutionProtocolVersion = 3 as const

/**
 * Stable native queue-name prefix for adapter version `1`.
 *
 * **Details**
 *
 * The full SHA-256 route digest keeps
 * `DurableQueue/${NativeQueueNamePrefix}<hex>` below the current native SQL
 * queue-name limit.
 *
 * @category constants
 * @since 4.0.0
 */
export const NativeQueueNamePrefix = "ewbq3a1/" as const

/**
 * Immutable semantic route of one native node-worker pool.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkerRouteDocument = Schema.Struct({
  routeVersion: Schema.Literal(1),
  executionProtocolVersion: Schema.Literal(ExecutionProtocolVersion),
  logicalQueue: Wire.AtomicIdentifier,
  workerDeploymentId: Wire.AtomicIdentifier,
  handlerBuildDigest: Wire.BuildDigest
}).annotate({
  identifier: "WorkflowEffectDurableQueueV3WorkerRouteDocument",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkerRouteDocument}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerRouteDocument = Schema.Schema.Type<
  typeof WorkerRouteDocument
>

/**
 * Persistable native worker route and its domain-separated digest.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkerRoutePin = Schema.Struct({
  document: WorkerRouteDocument,
  routeDigest: Wire.Sha256Digest
}).annotate({
  identifier: "WorkflowEffectDurableQueueV3WorkerRoutePin",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkerRoutePin}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerRoutePin = Schema.Schema.Type<
  typeof WorkerRoutePin
>

/**
 * Process-local prepared route retaining its exact native queue definition.
 *
 * **Details**
 *
 * Public fields are inspectable diagnostics. Authority comes from
 * {@link prepareRoute} or {@link prepareRouteForNode}; structural copies are
 * rejected.
 *
 * @category models
 * @since 4.0.0
 */
export interface PreparedWorkerRoute extends WorkerRoutePin {
  readonly nativeQueueName: string
}

const workItemIssues = (
  value: Schema.Schema.Type<typeof NodeAttemptWorkItemStruct>
): ReadonlyArray<Schema.FilterIssue> => {
  const issues: Array<Schema.FilterIssue> = []
  const document = value.operation.document
  if (
    document._tag !== "Activity" ||
    document.purpose._tag !== "NodeAttempt"
  ) {
    issues.push({
      path: ["operation", "document", "purpose"],
      issue: "queued work must select one managed NodeAttempt activity"
    })
    return issues
  }
  const occurrence = document.occurrence
  const coordinates = occurrence.document
  const equal = (
    actual: unknown,
    expected: unknown,
    path: ReadonlyArray<string | number>,
    issue: string
  ): void => {
    if (actual !== expected) {
      issues.push({ path, issue })
    }
  }
  equal(
    value.tenantId,
    coordinates.tenantId,
    ["tenantId"],
    "tenantId must equal the nested occurrence tenant"
  )
  equal(
    value.runId,
    coordinates.runId,
    ["runId"],
    "runId must equal the nested occurrence run"
  )
  equal(
    value.artifactDigest,
    coordinates.artifactDigest,
    ["artifactDigest"],
    "artifactDigest must equal the nested occurrence artifact"
  )
  equal(
    value.nodeId,
    coordinates.nodeId,
    ["nodeId"],
    "nodeId must equal the nested occurrence node"
  )
  equal(
    value.occurrenceDigest,
    occurrence.occurrenceDigest,
    ["occurrenceDigest"],
    "occurrenceDigest must equal the nested occurrence pin"
  )
  equal(
    value.operationId,
    document.operationId,
    ["operationId"],
    "operationId must equal the nested activity operation"
  )
  equal(
    value.attempt,
    document.attempt,
    ["attempt"],
    "attempt must equal the nested activity attempt"
  )
  equal(
    value.route.document.handlerBuildDigest,
    document.purpose.handlerBuildDigest,
    ["route", "document", "handlerBuildDigest"],
    "route handler build must equal the managed activity build"
  )
  equal(
    value.handlerIdempotencyKey,
    Identity.durableActivityIdempotencyKey(
      coordinates.tenantId,
      coordinates.runId,
      occurrence.occurrenceDigest
    ),
    ["handlerIdempotencyKey"],
    "handler idempotency key must equal the canonical durable node-instance identity"
  )
  return issues
}

const NodeAttemptWorkItemStruct = Schema.Struct({
  adapterVersion: Schema.Literal(AdapterVersion),
  executionProtocolVersion: Schema.Literal(
    ExecutionProtocolVersion
  ),
  route: WorkerRoutePin,
  tenantId: Wire.AtomicIdentifier,
  runId: Wire.LineageIdentifier,
  artifactDigest: Wire.ArtifactDigest,
  nodeId: Wire.AtomicIdentifier,
  occurrenceDigest: Wire.OccurrenceDigest,
  operationId: Wire.AtomicIdentifier,
  attempt: Wire.PositiveSafeInt,
  operation: SemanticOperationV3.OperationPin,
  handlerIdempotencyKey: Wire.Identifier
})

/**
 * Strict, independently inspectable work item sent to one native worker route.
 *
 * **Details**
 *
 * Duplicated coordinates are relationally checked against the nested
 * content-addressed operation. The complete operation pin remains the
 * authoritative payload and commits input, attempt, artifact, node, build,
 * codecs, and result contracts.
 *
 * @category schemas
 * @since 4.0.0
 */
export const NodeAttemptWorkItem = NodeAttemptWorkItemStruct.check(
  Schema.makeFilter(workItemIssues)
).annotate({
  identifier: "WorkflowEffectDurableQueueV3NodeAttemptWorkItem",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link NodeAttemptWorkItem}.
 *
 * @category models
 * @since 4.0.0
 */
export type NodeAttemptWorkItem = Schema.Schema.Type<
  typeof NodeAttemptWorkItem
>

/**
 * Stable adapter failure codes raised before native queue processing.
 *
 * @category constants
 * @since 4.0.0
 */
export const ErrorCodes = {
  InvalidResolution: "InvalidResolution",
  InvalidRoute: "InvalidRoute",
  UnknownNode: "UnknownNode",
  RouteMismatch: "RouteMismatch",
  InvalidWorkItem: "InvalidWorkItem",
  RouteDigestFailed: "RouteDigestFailed",
  InvalidWorkerOptions: "InvalidWorkerOptions",
  UnsupportedPolicy: "UnsupportedPolicy"
} as const

/**
 * A stable adapter failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]

const ErrorCode = Schema.Literals([
  ErrorCodes.InvalidResolution,
  ErrorCodes.InvalidRoute,
  ErrorCodes.UnknownNode,
  ErrorCodes.RouteMismatch,
  ErrorCodes.InvalidWorkItem,
  ErrorCodes.RouteDigestFailed,
  ErrorCodes.InvalidWorkerOptions,
  ErrorCodes.UnsupportedPolicy
])

/**
 * Raised while preparing or selecting the optional native queue transport.
 *
 * @category errors
 * @since 4.0.0
 */
export class EffectWorkflowDurableQueueError extends Schema.TaggedErrorClass<
  EffectWorkflowDurableQueueError
>("@effect/workflow-builder/EffectWorkflowDurableQueueV3/Error")(
  "EffectWorkflowDurableQueueError",
  {
    code: ErrorCode,
    message: Schema.NonEmptyString,
    nodeId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationId: Schema.optionalKey(Wire.AtomicIdentifier),
    operationDigest: Schema.optionalKey(Wire.OperationDigest),
    routeDigest: Schema.optionalKey(Wire.Sha256Digest)
  },
  { parseOptions: strictParseOptions }
) {}

const adapterError = (
  code: ErrorCode,
  message: string,
  options: {
    readonly nodeId?: string | undefined
    readonly operationId?: string | undefined
    readonly operationDigest?: Wire.OperationDigest | undefined
    readonly routeDigest?: Wire.Sha256Digest | undefined
  } = {}
): EffectWorkflowDurableQueueError =>
  new EffectWorkflowDurableQueueError({
    code,
    message,
    ...(options.nodeId === undefined
      ? undefined
      : { nodeId: options.nodeId }),
    ...(options.operationId === undefined
      ? undefined
      : { operationId: options.operationId }),
    ...(options.operationDigest === undefined
      ? undefined
      : { operationDigest: options.operationDigest }),
    ...(options.routeDigest === undefined
      ? undefined
      : { routeDigest: options.routeDigest })
  })

/**
 * Stable worker-attestation failure codes returned through the queue's
 * infrastructure error channel.
 *
 * @category constants
 * @since 4.0.0
 */
export const WorkerFailureCodes = {
  RouteMismatch: "RouteMismatch",
  ArtifactUnavailable: "ArtifactUnavailable",
  ArtifactInvalid: "ArtifactInvalid",
  OperationInvalid: "OperationInvalid",
  ArtifactResolutionFailed: "ArtifactResolutionFailed",
  ActivityResolutionFailed: "ActivityResolutionFailed",
  PinMismatch: "PinMismatch",
  SemanticBoundaryRejected: "SemanticBoundaryRejected"
} as const

/**
 * A stable worker-attestation failure code.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerFailureCode = typeof WorkerFailureCodes[keyof typeof WorkerFailureCodes]

const WorkerFailureCode = Schema.Literals([
  WorkerFailureCodes.RouteMismatch,
  WorkerFailureCodes.ArtifactUnavailable,
  WorkerFailureCodes.ArtifactInvalid,
  WorkerFailureCodes.OperationInvalid,
  WorkerFailureCodes.ArtifactResolutionFailed,
  WorkerFailureCodes.ActivityResolutionFailed,
  WorkerFailureCodes.PinMismatch,
  WorkerFailureCodes.SemanticBoundaryRejected
])

/**
 * Closed infrastructure failure returned when a worker cannot attest an exact
 * work item.
 *
 * **Details**
 *
 * This is never a node business failure. The workflow host converts it to a
 * native defect before entering the `NodeAttemptOutcome` boundary.
 *
 * @category errors
 * @since 4.0.0
 */
export class WorkerFailure extends Schema.TaggedErrorClass<WorkerFailure>(
  "@effect/workflow-builder/EffectWorkflowDurableQueueV3/WorkerFailure"
)(
  "WorkerFailure",
  {
    code: WorkerFailureCode,
    message: Schema.NonEmptyString,
    routeDigest: Wire.Sha256Digest,
    tenantId: Wire.AtomicIdentifier,
    artifactDigest: Wire.ArtifactDigest,
    nodeId: Wire.AtomicIdentifier,
    operationId: Wire.AtomicIdentifier,
    operationDigest: Wire.OperationDigest
  },
  { parseOptions: strictParseOptions }
) {}

/**
 * Plain structured defect persisted when worker attestation fails.
 *
 * **Details**
 *
 * `Schema.Defect` intentionally normalizes JavaScript `Error` instances to
 * their standard fields. Wrapping {@link WorkerFailure} in this plain object
 * preserves its route, artifact, node, and operation coordinates across the
 * native activity defect codec.
 *
 * @category schemas
 * @since 4.0.0
 */
export const WorkerDefect = Schema.Struct({
  _tag: Schema.Literal("EffectWorkflowDurableQueueWorkerDefect"),
  defectVersion: Schema.Literal(1),
  failure: WorkerFailure
}).annotate({
  identifier: "WorkflowEffectDurableQueueV3WorkerDefect",
  parseOptions: strictParseOptions
})

/**
 * The decoded type of {@link WorkerDefect}.
 *
 * @category models
 * @since 4.0.0
 */
export type WorkerDefect = Schema.Schema.Type<
  typeof WorkerDefect
>

type NativeNodeAttemptQueue = NativeDurableQueue.DurableQueue<
  typeof NodeAttemptWorkItem,
  typeof EffectWorkflowSemanticV3.NodeAttemptHandlerResult,
  typeof WorkerFailure
>

const workerFailure = (
  work: NodeAttemptWorkItem,
  code: WorkerFailureCode,
  message: string
): WorkerFailure =>
  new WorkerFailure({
    code,
    message,
    routeDigest: work.route.routeDigest,
    tenantId: work.tenantId,
    artifactDigest: work.artifactDigest,
    nodeId: work.nodeId,
    operationId: work.operationId,
    operationDigest: work.operation.operationDigest
  })

const workerDefect = (
  failure: WorkerFailure
): WorkerDefect =>
  Object.freeze({
    _tag: "EffectWorkflowDurableQueueWorkerDefect",
    defectVersion: 1,
    failure
  })

const nativeQueueName = (
  routeDigest: Wire.Sha256Digest
): string => `${NativeQueueNamePrefix}${routeDigest.slice("sha256:".length)}`

const makeNativeQueue = (
  name: string
): NativeNodeAttemptQueue =>
  NativeDurableQueue.make({
    name,
    payload: NodeAttemptWorkItem,
    success: EffectWorkflowSemanticV3.NodeAttemptHandlerResult,
    error: WorkerFailure,
    idempotencyKey: (work) =>
      Identity.nativeNodeAttemptWorkIdempotencyKey(
        work.route.routeDigest,
        work.operation.operationDigest
      )
  })

const routeDocumentFromBinding = (
  binding: PlanStoreV3.NodeBinding
): WorkerRouteDocument => ({
  routeVersion: 1,
  executionProtocolVersion: ExecutionProtocolVersion,
  logicalQueue: binding.queue,
  workerDeploymentId: binding.handlerBuild.deploymentId,
  handlerBuildDigest: binding.handlerBuild.buildDigest
})

const prepareBindingRoute = (
  binding: PlanStoreV3.NodeBinding
): Effect.Effect<
  PreparedWorkerRoute,
  EffectWorkflowDurableQueueError,
  Crypto.Crypto
> =>
  Effect.gen(function*() {
    const documentResult = Schema.decodeUnknownResult(
      WorkerRouteDocument,
      strictParseOptions
    )(routeDocumentFromBinding(binding))
    if (Result.isFailure(documentResult)) {
      return yield* Effect.fail(adapterError(
        ErrorCodes.InvalidRoute,
        `Native worker route is invalid: ${documentResult.failure.message}`,
        { nodeId: binding.nodeId }
      ))
    }
    const document = Object.freeze(documentResult.success)
    const routeDigest = yield* DigestV3.nativeWorkerRoute(
      document
    ).pipe(
      Effect.mapError(() =>
        adapterError(
          ErrorCodes.RouteDigestFailed,
          "Native worker route digest could not be computed",
          { nodeId: binding.nodeId }
        )
      )
    )
    const route: PreparedWorkerRoute = Object.freeze({
      document,
      routeDigest,
      nativeQueueName: nativeQueueName(routeDigest)
    })
    preparedRoutes.set(
      route,
      makeNativeQueue(route.nativeQueueName)
    )
    return route
  })

/**
 * Prepares a native worker route from one exact managed-attempt resolution.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareRoute = (
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
): Effect.Effect<
  PreparedWorkerRoute,
  EffectWorkflowDurableQueueError,
  Crypto.Crypto
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "NodeAttempt"
  ) {
    return Effect.fail(adapterError(
      ErrorCodes.InvalidResolution,
      "Native queue route preparation requires an exact NodeAttempt resolution"
    ))
  }
  return prepareBindingRoute(resolution.node.binding)
}

/**
 * Prepares a worker-deployment route from an exact resolved artifact node.
 *
 * **Details**
 *
 * This constructor lets a worker process prepare its route without creating a
 * synthetic node attempt. The artifact and executable registry remain the
 * authority for the selected binding.
 *
 * @category constructors
 * @since 4.0.0
 */
export const prepareRouteForNode = (
  artifact: SemanticExecutableRegistryV3.ResolvedArtifactExecutables,
  nodeId: string
): Effect.Effect<
  PreparedWorkerRoute,
  EffectWorkflowDurableQueueError,
  Crypto.Crypto
> => {
  if (
    !SemanticExecutableRegistryV3.isResolvedArtifactExecutables(
      artifact
    )
  ) {
    return Effect.fail(adapterError(
      ErrorCodes.InvalidResolution,
      "Worker route preparation requires exact resolved artifact executables",
      { nodeId }
    ))
  }
  const node = artifact.nodeHandlers.get(nodeId)
  return node === undefined
    ? Effect.fail(adapterError(
      ErrorCodes.UnknownNode,
      "Worker route node is absent from the exact resolved artifact",
      { nodeId }
    ))
    : prepareBindingRoute(node.binding)
}

/**
 * Tests whether a value is an exact route prepared in this process.
 *
 * @category guards
 * @since 4.0.0
 */
export const isPreparedRoute = (
  value: unknown
): value is PreparedWorkerRoute =>
  typeof value === "object" &&
  value !== null &&
  preparedRoutes.has(value)

const routeQueue = (
  route: PreparedWorkerRoute
): Result.Result<
  NativeNodeAttemptQueue,
  EffectWorkflowDurableQueueError
> => {
  const queue = preparedRoutes.get(route)
  return queue === undefined
    ? Result.fail(adapterError(
      ErrorCodes.InvalidRoute,
      "Expected the exact PreparedWorkerRoute returned by a route constructor"
    ))
    : Result.succeed(queue)
}

const routeMatchesResolution = (
  route: PreparedWorkerRoute,
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
): boolean => {
  const binding = resolution.node.binding
  return route.document.logicalQueue === binding.queue &&
    route.document.workerDeploymentId ===
      binding.handlerBuild.deploymentId &&
    route.document.handlerBuildDigest ===
      binding.handlerBuild.buildDigest
}

const decodeWorkItem = Schema.decodeUnknownResult(
  NodeAttemptWorkItem,
  strictParseOptions
)

/**
 * Builds the exact detached queue payload for one prepared route and managed
 * attempt.
 *
 * @category constructors
 * @since 4.0.0
 */
export const makeWorkItem = (
  route: PreparedWorkerRoute,
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity
): Result.Result<
  NodeAttemptWorkItem,
  EffectWorkflowDurableQueueError
> => {
  const queue = routeQueue(route)
  if (Result.isFailure(queue)) return Result.fail(queue.failure)
  if (
    !SemanticExecutableRegistryV3.isResolvedActivity(resolution) ||
    resolution._tag !== "NodeAttempt"
  ) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidResolution,
      "Native queue work requires an exact NodeAttempt resolution"
    ))
  }
  const document = resolution.operation.document
  if (
    document._tag !== "Activity" ||
    document.purpose._tag !== "NodeAttempt"
  ) {
    return Result.fail(adapterError(
      ErrorCodes.InvalidResolution,
      "Native queue work no longer retains a managed Activity descriptor",
      {
        nodeId: resolution.node.binding.nodeId,
        operationDigest: resolution.operation.operationDigest
      }
    ))
  }
  if (!routeMatchesResolution(route, resolution)) {
    return Result.fail(adapterError(
      ErrorCodes.RouteMismatch,
      "Prepared worker route does not match the attempt's exact artifact binding",
      {
        nodeId: resolution.node.binding.nodeId,
        operationId: document.operationId,
        operationDigest: resolution.operation.operationDigest,
        routeDigest: route.routeDigest
      }
    ))
  }
  const timeouts = resolution.node.binding.activityPolicy.timeouts
  if (
    timeouts.scheduleToStart._tag !== "Disabled" ||
    timeouts.startToClose._tag !== "Disabled"
  ) {
    return Result.fail(adapterError(
      ErrorCodes.UnsupportedPolicy,
      "Native DurableQueue execution does not yet expose the worker acquisition needed for schedule-to-start or start-to-close fencing",
      {
        nodeId: resolution.node.binding.nodeId,
        operationId: document.operationId,
        operationDigest: resolution.operation.operationDigest,
        routeDigest: route.routeDigest
      }
    ))
  }
  const occurrence = document.occurrence
  const coordinates = occurrence.document
  let decoded: ReturnType<typeof decodeWorkItem>
  try {
    decoded = decodeWorkItem({
      adapterVersion: AdapterVersion,
      executionProtocolVersion: ExecutionProtocolVersion,
      route: {
        document: route.document,
        routeDigest: route.routeDigest
      },
      tenantId: coordinates.tenantId,
      runId: coordinates.runId,
      artifactDigest: coordinates.artifactDigest,
      nodeId: coordinates.nodeId,
      occurrenceDigest: occurrence.occurrenceDigest,
      operationId: document.operationId,
      attempt: document.attempt,
      operation: resolution.operation,
      handlerIdempotencyKey: Identity.durableActivityIdempotencyKey(
        coordinates.tenantId,
        coordinates.runId,
        occurrence.occurrenceDigest
      )
    })
  } catch {
    return Result.fail(adapterError(
      ErrorCodes.InvalidWorkItem,
      "Native queue work-item validation threw unexpectedly",
      {
        nodeId: coordinates.nodeId,
        operationId: document.operationId,
        operationDigest: resolution.operation.operationDigest,
        routeDigest: route.routeDigest
      }
    ))
  }
  return Result.isFailure(decoded)
    ? Result.fail(adapterError(
      ErrorCodes.InvalidWorkItem,
      `Native queue work item is invalid: ${decoded.failure.message}`,
      {
        nodeId: coordinates.nodeId,
        operationId: document.operationId,
        operationDigest: resolution.operation.operationDigest,
        routeDigest: route.routeDigest
      }
    ))
    : Result.succeed(Object.freeze(decoded.success))
}

/**
 * Explicit workflow-side native queue execution options.
 *
 * @category models
 * @since 4.0.0
 */
export interface ExecutionOptions extends EffectWorkflowSemanticV3.ActivityExecutionOptions {
  /**
   * Retries only failures while offering the durable queue item.
   */
  readonly offerRetryPolicy: Schedule.Schedule<
    any,
    PersistedQueue.PersistedQueueError
  >
}

/**
 * Executes one managed attempt through native `DurableQueue` and returns its
 * authoritative native activity receipt.
 *
 * **Details**
 *
 * Descriptor binding occurs before the activity executes. Queue processing
 * then suspends inside that same activity until an exact worker result
 * arrives. Worker-attestation failures are re-emitted as defects so they can
 * never enter the node's business-failure vocabulary.
 *
 * The current native queue callback does not expose an acquisition capability
 * or lease-loss signal. This adapter therefore rejects bindings with
 * schedule-to-start or start-to-close enabled instead of pretending that
 * enqueue or callback entry is a fenced semantic start. Schedule-to-close
 * remains owned by the outer retry controller.
 *
 * @category execution
 * @since 4.0.0
 */
export const completion = (
  route: PreparedWorkerRoute,
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  options: ExecutionOptions
): Effect.Effect<
  EffectWorkflowSemanticV3.NodeAttemptCompletion,
  | EffectWorkflowDurableQueueError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | EffectWorkflowSemanticV3.Requirements
  | PersistedQueue.PersistedQueueFactory
> => {
  const queue = routeQueue(route)
  if (Result.isFailure(queue)) return Effect.fail(queue.failure)
  const work = makeWorkItem(route, resolution)
  if (Result.isFailure(work)) return Effect.fail(work.failure)
  const handlerResult = NativeDurableQueue.process(
    queue.success,
    work.success,
    { retrySchedule: options.offerRetryPolicy }
  ).pipe(
    Effect.catch((failure) => Effect.die(workerDefect(failure)))
  )
  return EffectWorkflowSemanticV3
    .nodeAttemptCompletionWithHandlerResult(
      resolution,
      {
        backendBindingVersion: 1,
        backendId: "NativeDurableQueue",
        backendVersion: String(AdapterVersion),
        configurationDigest: route.routeDigest
      },
      handlerResult,
      options
    )
}

/**
 * Executes one managed attempt through native `DurableQueue`.
 *
 * @category execution
 * @since 4.0.0
 */
export const execute = (
  route: PreparedWorkerRoute,
  resolution: SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  options: ExecutionOptions
): Effect.Effect<
  SemanticOperationV3.NodeAttemptOutcome,
  | EffectWorkflowDurableQueueError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  | EffectWorkflowSemanticV3.Requirements
  | PersistedQueue.PersistedQueueFactory
> =>
  Effect.flatMap(
    completion(route, resolution, options),
    (receipt) => receipt.exit
  )

/**
 * Explicit native queue options captured by a managed-retry executor.
 *
 * @category models
 * @since 4.0.0
 */
export interface RetryExecutorOptions {
  /**
   * Retries only failures while offering one semantic attempt to the native
   * persisted queue.
   */
  readonly offerRetryPolicy: Schedule.Schedule<
    any,
    PersistedQueue.PersistedQueueError
  >
}

/**
 * Creates an attempt executor consumable by
 * `EffectWorkflowRetryV3.executeWithExecutor`.
 *
 * **Details**
 *
 * The retry engine still creates every semantic attempt and owns
 * classification, backoff, and schedule-to-close. This function only closes
 * the prepared route and native offer policy over {@link completion}.
 *
 * @category constructors
 * @since 4.0.0
 */
export const retryAttemptExecutor = (
  route: PreparedWorkerRoute,
  options: RetryExecutorOptions
): EffectWorkflowRetryV3.AttemptExecutor<
  | EffectWorkflowDurableQueueError
  | EffectWorkflowSemanticV3.EffectWorkflowSemanticError,
  PersistedQueue.PersistedQueueFactory
> =>
(
  resolution,
  executionOptions
) =>
  completion(route, resolution, {
    interruptRetryPolicy: executionOptions.interruptRetryPolicy,
    offerRetryPolicy: options.offerRetryPolicy
  })

const sameRoutePin = (
  left: WorkerRoutePin,
  right: PreparedWorkerRoute
): boolean =>
  left.routeDigest === right.routeDigest &&
  left.document.routeVersion === right.document.routeVersion &&
  left.document.executionProtocolVersion ===
    right.document.executionProtocolVersion &&
  left.document.logicalQueue === right.document.logicalQueue &&
  left.document.workerDeploymentId ===
    right.document.workerDeploymentId &&
  left.document.handlerBuildDigest ===
    right.document.handlerBuildDigest

const resolveWorkItem = (
  route: PreparedWorkerRoute,
  work: NodeAttemptWorkItem
): Effect.Effect<
  SemanticExecutableRegistryV3.ResolvedNodeAttemptActivity,
  WorkerFailure,
  | Crypto.Crypto
  | PlanStoreV3.PlanStoreV3
  | SemanticExecutableRegistryV3.SemanticExecutableRegistryV3
> =>
  Effect.gen(function*() {
    if (!sameRoutePin(work.route, route)) {
      return yield* Effect.fail(workerFailure(
        work,
        WorkerFailureCodes.RouteMismatch,
        "Work item was delivered to a different native worker route"
      ))
    }
    const store = yield* PlanStoreV3.PlanStoreV3
    const artifact = yield* store.getArtifact({
      tenantId: work.tenantId,
      artifactDigest: work.artifactDigest
    }).pipe(
      Effect.mapError(() =>
        workerFailure(
          work,
          WorkerFailureCodes.ArtifactUnavailable,
          "Pinned workflow artifact is unavailable to the worker"
        )
      )
    )
    const verified = yield* PlanStoreV3.verifyArtifact(
      artifact,
      work.artifactDigest
    ).pipe(
      Effect.mapError(() =>
        workerFailure(
          work,
          WorkerFailureCodes.ArtifactInvalid,
          "Pinned workflow artifact failed complete digest verification"
        )
      )
    )
    const operation = yield* SemanticOperationV3.verify(
      work.operation
    ).pipe(
      Effect.mapError(() =>
        workerFailure(
          work,
          WorkerFailureCodes.OperationInvalid,
          "Queued semantic operation failed content-address verification"
        )
      )
    )
    const registry = yield* SemanticExecutableRegistryV3.SemanticExecutableRegistryV3
    const resolvedArtifact = yield* registry.resolveArtifact(
      verified
    ).pipe(
      Effect.mapError(() =>
        workerFailure(
          work,
          WorkerFailureCodes.ArtifactResolutionFailed,
          "Worker executable registry cannot resolve every artifact pin"
        )
      )
    )
    const resolutionResult = SemanticExecutableRegistryV3.resolveActivity(
      resolvedArtifact,
      operation
    )
    if (Result.isFailure(resolutionResult)) {
      return yield* Effect.fail(workerFailure(
        work,
        WorkerFailureCodes.ActivityResolutionFailed,
        "Worker executable registry rejected the exact activity operation"
      ))
    }
    const resolution = resolutionResult.success
    if (
      resolution._tag !== "NodeAttempt" ||
      !routeMatchesResolution(route, resolution) ||
      resolution.artifact.artifactDigest !==
        work.artifactDigest ||
      resolution.node.binding.nodeId !== work.nodeId
    ) {
      return yield* Effect.fail(workerFailure(
        work,
        WorkerFailureCodes.PinMismatch,
        "Resolved worker activity does not match the queued artifact, node, route, and build pins"
      ))
    }
    return resolution
  })

/**
 * Explicit native worker-pool options.
 *
 * @category models
 * @since 4.0.0
 */
export interface WorkerOptions {
  /**
   * Maximum number of work items evaluated concurrently by this Layer.
   */
  readonly concurrency: number

  /**
   * Native `PersistedQueue.take` limit for non-interrupt acquisition
   * failures.
   *
   * **Details**
   *
   * The durable queue captures handler outcomes into its deferred result, so
   * this does not retry business failures or handler defects.
   */
  readonly nativeQueueMaxAttempts: number

  /**
   * Retries only worker-side artifact and executable attestation.
   *
   * **Details**
   *
   * The node handler starts only after this schedule finishes successfully.
   * Handler business failures and defects are never retried by this policy.
   */
  readonly attestationRetryPolicy: Schedule.Schedule<
    any,
    WorkerFailure
  >
}

/**
 * Builds a scoped native worker Layer for one exact prepared route.
 *
 * **Details**
 *
 * Native `DurableQueue.worker` owns the persistent worker loop and
 * concurrency. Each delivery reloads and verifies the artifact, verifies the
 * operation digest, resolves exact executable pins, and checks the queue,
 * deployment, and build before user code is constructed.
 *
 * Delivery is at-least-once. The adapter does not claim lease-loss fencing,
 * remote cancellation, configurable native dead-letter handling, or
 * exactly-once external effects. Worker-attestation retry is explicit here;
 * failures outside the captured handler result remain governed by the
 * separately supplied native queue limit.
 *
 * @category layers
 * @since 4.0.0
 */
export const worker = (
  route: PreparedWorkerRoute,
  options: WorkerOptions
): Layer.Layer<
  never,
  EffectWorkflowDurableQueueError,
  | Crypto.Crypto
  | NativeWorkflowEngine.WorkflowEngine
  | PersistedQueue.PersistedQueueFactory
  | PlanStoreV3.PlanStoreV3
  | SemanticExecutableRegistryV3.SemanticExecutableRegistryV3
> => {
  const queue = routeQueue(route)
  if (Result.isFailure(queue)) {
    return Layer.effectDiscard(Effect.fail(queue.failure))
  }
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency <= 0 ||
    !Number.isSafeInteger(options.nativeQueueMaxAttempts) ||
    options.nativeQueueMaxAttempts <= 0
  ) {
    return Layer.effectDiscard(Effect.fail(adapterError(
      ErrorCodes.InvalidWorkerOptions,
      "Native worker concurrency and queue max attempts must be positive safe integers",
      { routeDigest: route.routeDigest }
    )))
  }
  return NativeDurableQueue.worker(
    queue.success,
    (work) =>
      Effect.flatMap(
        resolveWorkItem(route, work).pipe(
          Effect.retry(options.attestationRetryPolicy)
        ),
        (resolution) =>
          EffectWorkflowSemanticV3.runNodeAttemptHandler(
            resolution
          ).pipe(
            Effect.mapError(() =>
              workerFailure(
                work,
                WorkerFailureCodes.SemanticBoundaryRejected,
                "Worker semantic handler boundary rejected the exact resolution"
              )
            )
          )
      ),
    {
      concurrency: options.concurrency,
      maxAttempts: options.nativeQueueMaxAttempts
    }
  )
}
