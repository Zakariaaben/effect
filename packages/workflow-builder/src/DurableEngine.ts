/**
 * A single-node durable `WorkflowEngine` preset over a SQL database.
 *
 * This is the production counterpart of `WorkflowEngine.layerMemory`: run
 * requests, activity results, deferred decisions, and timer wake-ups persist
 * in `cluster_*` tables (created automatically), so runs survive process
 * crashes and restarts. It composes the native cluster workflow engine with
 * in-process defaults — no sockets, no shard manager, no second machine —
 * while remaining the same engine that scales to a multi-runner deployment
 * by swapping the runner layers.
 *
 * The application supplies the `SqlClient` (SQLite for a single box,
 * Postgres or MySQL for a server) and provides this layer where the engine's
 * `Engine.layer` expects a `WorkflowEngine`.
 *
 * @since 4.0.0
 */
import * as Layer from "effect/Layer"
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine"
import * as RunnerHealth from "effect/unstable/cluster/RunnerHealth"
import * as Runners from "effect/unstable/cluster/Runners"
import * as RunnerStorage from "effect/unstable/cluster/RunnerStorage"
import * as Sharding from "effect/unstable/cluster/Sharding"
import * as ShardingConfig from "effect/unstable/cluster/ShardingConfig"
import * as SqlMessageStorage from "effect/unstable/cluster/SqlMessageStorage"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"

/**
 * Options for {@link layer}.
 *
 * @category models
 * @since 4.0.0
 */
export interface Options {
  /**
   * Overrides for the sharding configuration.
   *
   * **Details**
   *
   * `shardsPerGroup` and the shard groups are baked into persisted message
   * rows and must stay stable across restarts of the same database.
   * `entityMessagePollInterval` bounds recovery and timer latency; lower it
   * for tests, keep the default for servers.
   */
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined
  /**
   * Prefix for the automatically created storage tables (default `cluster`).
   * Must stay stable across restarts of the same database.
   */
  readonly storagePrefix?: string | undefined
}

/**
 * Builds the single-node durable workflow engine over an application-supplied
 * `SqlClient`.
 *
 * **Details**
 *
 * Message storage — the durable journal of run requests, activity replies,
 * deferred results, and scheduled wake-ups — lives in SQL and is the only
 * state that must survive a crash. Shard ownership uses in-memory runner
 * storage, so a restarted process reacquires its shards immediately instead
 * of waiting out stale locks. In-flight work interrupted by a crash is
 * redelivered on restart and completed steps replay from their persisted
 * results; a run suspended on a decision or timer wakes exactly as it would
 * have in the original process.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (
  options?: Options
): Layer.Layer<
  WorkflowEngine.WorkflowEngine | Sharding.Sharding,
  never,
  SqlClient.SqlClient
> =>
  ClusterWorkflowEngine.layer.pipe(
    Layer.provideMerge(Sharding.layer),
    Layer.provide(Runners.layerNoop),
    Layer.provideMerge(
      options?.storagePrefix === undefined
        ? SqlMessageStorage.layer
        : SqlMessageStorage.layerWith({ prefix: options.storagePrefix })
    ),
    Layer.provide(RunnerStorage.layerMemory),
    Layer.provide(RunnerHealth.layerNoop),
    Layer.provide(ShardingConfig.layer(options?.shardingConfig))
  ) as Layer.Layer<
    WorkflowEngine.WorkflowEngine | Sharding.Sharding,
    never,
    SqlClient.SqlClient
  >
