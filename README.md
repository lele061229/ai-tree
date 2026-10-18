# AI Knowledge OS — baseline interaction prototype

This is a private, buildless prototype using fictional content. It demonstrates a knowledge graph presented as an ability tree; versioned import and incremental merge; source tracing; node learning spaces; and separate ability evidence and project stage semantics. It does **not** connect to chat histories, external accounts, AI providers, databases or real project repositories. Import results and mentor responses are explicitly labelled as preset demonstrations.

## Run and verify

Requires Node.js 18+ for tests. There are no third-party runtime dependencies or build steps.

```sh
npm test
```

Serve `dist/` with any static HTTP server. For example, with Python 3 available, run `python3 -m http.server 8080 --directory dist`, then open `http://localhost:8080`. ES modules require HTTP rather than opening index.html directly. In the managed Sites environment use the platform preview and deployment workflow. `.openai/hosting.json` identifies the existing private Site.

## Modules

- `dist/app.js`: UI actions, view state and orchestration.
- `dist/modules/graph.js`: SVG relationships, DOM nodes, pan/zoom and filters.
- `dist/modules/panels.js`: learning space, source entry points, review, history, goals.
- `dist/modules/domain.js`: pure graph validation, prerequisite traversal, immutable incremental merge and recommendation rules.
- `dist/modules/storage.js`: versioned browser-local persistence. The previous prototype's storage key is preserved and is not interpreted as proof of mastery.
- `dist/modules/seed.js`: fictional source material and two deterministic example batches.
- `dist/modules/base-data.js`: authored example textbook content; not an AI engine.
- `dist/modules/ui.js`: text escaping, icons and basic UI primitives.

## Data and boundaries

Each snapshot contains nodes, source documents, applied batch IDs and conflict records. Applying an example batch creates a new snapshot; old snapshots remain immutable. Replaying the same batch creates no duplicates or new version. Existing source IDs cannot be overwritten. Knowledge status is one of five evidence levels; project status is one of six stages. A conflict acknowledgement is required for the sync example, and the merge does not advance the project's stage. Task checkboxes and quiz responses are stored separately, scoped to a version, and never change the evidence level. History views are read-only.

Progress is stored only in the current browser, not synchronized between devices. Clearing browser site data removes local progress; this is not a production backup or restore system. Source and deployment history remain in the Site repository. No model-generated output is presented as verified implementation.

## Manual acceptance

1. Open a node and inspect all five learning tabs. Follow a source and return.
2. Load the built-in history example, review the three new nodes, apply and see v2.
3. Load the Skill example. Confirm apply is disabled until its conflict is acknowledged. Apply and see v3 with 22 nodes; the customer project remains `计划`.
4. Open route history. v1 contains 18 nodes and remains read-only; return to latest.
5. Repeat a batch and verify no duplicate version. Reload and check versions persist.
6. Verify project and ability filters, search empty state, goal-dependent paths, pan/zoom, and mobile panels.

This repository is a prototype asset, not the complete production software handoff described in the product baseline. A production modular monolith still needs an authorized import service, AI adapter, durable database schema/migrations, server authorization, evaluation pipeline, API documentation and tested backup/restore.

License: proprietary / UNLICENSED. No third-party application dependencies are included.
