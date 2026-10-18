# Validation record · self-hosted personal V1

Automated checks completed in the development container:

- **25 Python tests passed**: migration-created schema, session login/logout, CSRF and Origin enforcement, per-account isolation, immutable source deduplication, review/apply/version history, idempotent replay, historical progress protection, stale-preview conflict protection, server-persisted preferences and application restart, model-not-configured failure behavior, alias alignment, dependency cycle/unknown dependency rejection, real HTTP adapter request contract with MockTransport, invalid model JSON rejection, model/MySQL table-column parity, MySQL DDL compilation, private-file isolation, local secret initialization and refusal to overwrite configuration.
- **10 JavaScript tests passed**: prototype graph invariants, immutable merge, duplicate batch handling, source retention, conflict acknowledgement, goal paths, current/historical task counts.
- All frontend module files pass Node syntax checks; Python modules compile.
- Compose YAML parses; database has no host port; app maps loopback only; application filesystem is read-only.
- Compose 1.29.2 configuration parsing passed for both HTTPS IP and SSH-tunnel modes, with loopback-only app mapping, a private database, and health dependency retained. The isolated parser environment uses Python 3.12 and dependency-consistent PyYAML 5.4.1; it does not reproduce the target host kernel or Docker daemon.
- SSH-tunnel tests cover loopback-only initialization, rejection of public HTTP/invalid origins, runtime cookie guards, login, authenticated writes and logout.
- Backup/restore/entrypoint/Compose-wrapper/initializer shell syntax checks pass; Python dependency consistency check passes.

Python integration tests use temporary SQLite files and actual Alembic migrations. Model responses use test-only adapters and HTTP MockTransport. Tests do not send user content or make paid model calls.

**Not yet verified:** actual MySQL 8.4 container startup/authentication, Docker image build, live Aliyun deployment, production HTTPS/login, real model-provider request, SQL backup restore against MySQL, and the new server-mode browser flow. These require the target server and chosen provider configuration. The current environment has no Docker daemon or MySQL server. Do not label these items as passed based on SQLite tests.

The installed test-client stack emits a deprecation notice for its httpx integration; the tests pass. Runtime model HTTP requests are separate from TestClient. Before a later dependency upgrade, rerun the same tests and the server acceptance workflow.
