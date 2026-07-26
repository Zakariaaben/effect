/**
 * An ECM-style invoice flow: OCR extracts the amount, small invoices archive
 * automatically, large invoices wait for a human decision, and rejection is
 * an explicit business outcome — all composed by an end user from vocabulary
 * the application registered.
 */
import {
  Builtins,
  Compiler,
  Engine,
  Expression,
  HumanTasks,
  LinkPolicy,
  Node,
  PlanStore,
  Port,
  Registry,
  Runs,
  Workflow
} from "@effect/workflow-builder"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine"

// ----------------------------------------------------------------------------
// Vocabulary: what this platform's end users may orchestrate
// ----------------------------------------------------------------------------

const Invoice = Schema.Struct({
  vendor: Schema.String,
  amount: Schema.Number,
  currency: Schema.String
})

const ocr = Node.make("invoice/ocr", {
  version: "1.0.0",
  description: "Extracts structured invoice data from a scanned document",
  inputs: { document: Port.input(Schema.String, { contract: "app/document-url" }) },
  outputs: { invoice: Port.output(Invoice, { contract: "app/invoice" }) },
  policy: { retry: { maxAttempts: 3, initialDelayMillis: 500 } }
})

const archive = Node.make("invoice/archive", {
  version: "1.0.0",
  description: "Files the invoice in the document store",
  inputs: { invoice: Port.input(Invoice, { contract: "app/invoice" }) },
  outputs: { archiveId: Port.output(Schema.String, { contract: "app/archive-id" }) }
})

const registry = Registry.make(
  ocr,
  archive,
  Builtins.If,
  Builtins.HumanTask,
  Builtins.Transform,
  Builtins.Fail
)

const definition = Workflow.make("app/invoice-approval", {
  version: "1.0.0",
  inputs: {
    document: Port.output(Schema.String, { contract: "app/document-url" })
  },
  outputs: {
    archiveId: Port.input(Schema.String, { contract: "app/archive-id", required: false })
  },
  nodes: registry,
  linkPolicy: LinkPolicy.allowAll,
  limits: new Workflow.Limits({ maxNodes: 32, maxEdges: 64, maxFanIn: 8, maxFanOut: 8, maxDepth: 16 })
})

// ----------------------------------------------------------------------------
// The end user's plan
// ----------------------------------------------------------------------------

const plan = {
  formatVersion: 2,
  id: "invoice-approval",
  revision: 1,
  definition: { id: "app/invoice-approval", version: "1.0.0" },
  nodes: [
    { id: "scan", type: "invoice/ocr", version: "1.0.0", config: {} },
    {
      id: "needsApproval",
      type: "workflow/if",
      version: "1.0.0",
      config: {
        condition: Expression.compare(
          "gt",
          Expression.ref("nodes", "scan", "invoice", "amount"),
          Expression.literal(1000)
        )
      }
    },
    {
      id: "review",
      type: "workflow/humanTask",
      version: "1.0.0",
      config: {
        title: "Approve invoice",
        outcomes: ["approve", "reject"],
        candidateGroups: Expression.literal(["finance"]),
        payload: Expression.ref("nodes", "scan", "invoice"),
        dueInMillis: 3 * 24 * 60 * 60 * 1000
      }
    },
    {
      id: "file",
      type: "invoice/archive",
      version: "1.0.0",
      config: {},
      join: "any",
      bindings: { invoice: Expression.ref("nodes", "scan", "invoice") }
    },
    {
      id: "rejected",
      type: "workflow/fail",
      version: "1.0.0",
      config: {
        code: "INVOICE_REJECTED",
        message: Expression.template(
          "Invoice from ",
          Expression.ref("nodes", "scan", "invoice", "vendor"),
          " was rejected"
        )
      }
    },
    {
      id: "escalate",
      type: "workflow/fail",
      version: "1.0.0",
      config: { code: "REVIEW_EXPIRED", message: "The review deadline passed" }
    }
  ],
  edges: [
    {
      _tag: "DataEdge",
      id: "doc-to-scan",
      source: { _tag: "WorkflowInput", input: "document" },
      target: { _tag: "NodeInput", nodeId: "scan", input: "document" }
    },
    // Small invoices file directly; large ones only after approval.
    { _tag: "ControlEdge", id: "auto", sourceNodeId: "needsApproval", outcome: "false", targetNodeId: "file" },
    { _tag: "ControlEdge", id: "manual", sourceNodeId: "needsApproval", outcome: "true", targetNodeId: "review" },
    { _tag: "ControlEdge", id: "approved", sourceNodeId: "review", outcome: "approve", targetNodeId: "file" },
    { _tag: "ControlEdge", id: "declined", sourceNodeId: "review", outcome: "reject", targetNodeId: "rejected" },
    { _tag: "ControlEdge", id: "overdue", sourceNodeId: "review", outcome: "expired", targetNodeId: "escalate" },
    {
      _tag: "DataEdge",
      id: "file-out",
      source: { _tag: "NodeOutput", nodeId: "file", output: "archiveId" },
      target: { _tag: "WorkflowOutput", output: "archiveId" }
    }
  ]
}

// ----------------------------------------------------------------------------
// Wiring and a simulated end-to-end approval
// ----------------------------------------------------------------------------

const handlers = registry.toLayer(registry.of({
  "invoice/ocr@1.0.0": ({ inputs }) =>
    Effect.succeed({
      invoice: { vendor: "ACME", amount: inputs.document.includes("large") ? 5000 : 250, currency: "EUR" }
    }),
  "invoice/archive@1.0.0": ({ inputs }) => Effect.succeed({ archiveId: `arch-${inputs.invoice.vendor}` })
}))

const webCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>).then((buffer) => new Uint8Array(buffer)))
})

const EngineLive = Engine.layer(definition).pipe(
  Layer.provideMerge(Layer.mergeAll(handlers, PlanStore.layerMemory, HumanTasks.layerMemory)),
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(Layer.succeed(Crypto.Crypto)(webCrypto))
)

const program = Effect.gen(function*() {
  const compiled = yield* Compiler.compile(definition, plan)
  const store = yield* PlanStore.PlanStore
  yield* store.save(compiled)

  // A small invoice archives without any human involvement.
  const small = yield* Runs.execute("invoice-approval", { input: { document: "s3://small.pdf" } })

  // A large invoice suspends on the review task until finance decides.
  const handle = yield* Runs.start("invoice-approval", { input: { document: "s3://large.pdf" } })
  const tasks = yield* HumanTasks.HumanTasks
  let open = yield* tasks.list({ state: "open", candidateGroup: "finance" })
  while (open.length === 0) {
    yield* Effect.sleep("10 millis")
    open = yield* tasks.list({ state: "open", candidateGroup: "finance" })
  }
  yield* tasks.complete(open[0]!.taskId, { outcome: "approve", completedBy: "alice" })

  let status = yield* Runs.status(handle.runId)
  while (status._tag === "Running" || status._tag === "Suspended") {
    yield* Effect.sleep("10 millis")
    status = yield* Runs.status(handle.runId)
  }
  return { small: small.outputs, large: status }
}).pipe(Effect.provide(EngineLive))

Effect.runPromise(program).then((result) => console.log(JSON.stringify(result, null, 2)))
