// Layer rules for src/, enforced by `npx depcruise src --config .dependency-cruiser.cjs`.
// The generated import map lives in docs/arch/system-map.md (@arch:MAP-01/02);
// this file is the enforcement side described by @arch:MAP-03.
//
// `tsPreCompilationDeps` keeps `import type` edges in the report so the rules
// can distinguish a value import (runtime coupling) from a type-only one
// (erased at compile time).
module.exports = {
  forbidden: [
    {
      // model is side-effect-free, not import-free: types are always fine.
      // The three live readers below predate the rule and are accepted as-is
      // (their callers need the same evidence rows the store already reads).
      name: 'model-store-value-reads',
      severity: 'error',
      comment: 'model may only value-import store from the accepted live-read files (artifacts, graphLedger, ship).',
      from: {
        path: '^src/model/',
        pathNot: '^src/model/(artifacts|inside/graphLedger|inside/ship)\\.ts$',
      },
      to: { path: '^src/store/', dependencyTypesNot: ['type-only'] },
    },
    {
      // store may share pure serialization/formatting helpers with model; it
      // must not reach for a view-model module that carries a Store handle.
      name: 'store-model-pure-helpers',
      severity: 'error',
      comment: 'store may only value-import pure model helpers, never a model module that holds a Store.',
      from: { path: '^src/store/' },
      to: {
        path: '^src/model/',
        pathNot:
          '^src/model/(blockerNotify|bulletinRelevance|entityId|followUp|messageText|prChecks|prComments|prReview|time|types)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'store-no-workflow-value',
      severity: 'error',
      comment: 'store is persistence; it must not call the stage graph.',
      from: { path: '^src/store/' },
      to: { path: '^src/workflow/', dependencyTypesNot: ['type-only'] },
    },
    {
      // The stage graph is pure shape + transition rules. Only the two
      // side-effect-free lookup modules may be value-imported by model.
      name: 'model-workflow-pure',
      severity: 'error',
      comment: 'model may only value-import the pure workflow graph/fixAttempts lookups.',
      from: { path: '^src/model/' },
      to: {
        path: '^src/workflow/',
        pathNot: '^src/workflow/(fixAttempts|graph)\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'core-no-ui-value',
      severity: 'error',
      comment: 'The core stack (model/store/workflow/manifest/logging/template) must not value-import a webview.',
      from: {
        path: '^src/(model|store|workflow|manifest|logging|template)/|^src/(buildInfo|runtimeAssetsRoot)\\.ts$',
      },
      to: { path: '^src/ui/', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'core-no-entry-value',
      severity: 'error',
      comment: 'The core stack must not value-import the extension entry points.',
      from: {
        path: '^src/(model|store|workflow|manifest|logging|template)/|^src/(buildInfo|runtimeAssetsRoot)\\.ts$',
      },
      to: { path: '^src/(extension|extension\\.ts$|setup|commands|init)', dependencyTypesNot: ['type-only'] },
    },
    {
      // Core code that actually invokes the agent seam is named here. These are
      // the accepted exceptions from the W2 sweep; a new core -> agent value
      // import fails until it is either removed or added with a reason.
      name: 'core-agent-seam',
      severity: 'error',
      comment: 'Core may value-import agent/domain code only from the accepted seam modules listed in pathNot.',
      from: {
        path: '^src/(model|store|workflow|manifest|logging|template)/|^src/(buildInfo|runtimeAssetsRoot)\\.ts$',
        pathNot: [
          '^src/manifest/(foldProcessRows|schema)\\.ts$',
          '^src/model/(artifacts|inside/agent|inside/gates)\\.ts$',
          '^src/store/(interactiveUsageSamples|tickets|usageLimitParks)\\.ts$',
          '^src/workflow/(agentScope|graphMarkerGuard|messageDelivery|shipPreview|subtaskGate)\\.ts$',
          '^src/workflow/artifacts/(alignment|alignmentTrigger)\\.ts$',
          '^src/workflow/gates/gateConsole\\.ts$',
          '^src/workflow/review/(aggregate|findingsLane)\\.ts$',
          '^src/workflow/stages/(fix|uat)\\.ts$',
          '^src/workflow/uat/tester\\.ts$',
        ].join('|'),
      },
      to: {
        path: '^src/(agent|agents|hooks|context|planning|approaches)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'agent-no-ui-value',
      severity: 'error',
      comment: 'Agent adapters and domain code must not value-import a webview; the UI consumes them, not the reverse.',
      from: { path: '^src/(agent|agents|hooks|context|planning|approaches)/' },
      to: { path: '^src/ui/', dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // Keep `import type` dependencies in the report so the rules above can
    // tell them apart. The generator, not this flag, decides what to draw.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '\\.test\\.tsx?$|/fixtures/' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
