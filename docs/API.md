# Personal platform API

Requests are same-origin JSON. Except runtime/health/login, all `/api` operations require the session cookie. Mutations also require `X-CSRF-Token` returned by `/api/session`; an Origin header, when present, must match APP_ORIGIN. There is no public signup or cross-origin CORS grant.

| Method | Path | Behavior |
|---|---|---|
| GET | /api/runtime | Server mode and whether model configuration is present |
| GET | /api/health | Database connection health |
| POST | /api/login | `{username,password}`; set session cookie and return csrf |
| GET | /api/session | Current username and csrf token |
| POST | /api/logout | Revoke session and remove cookie |
| GET | /api/state | Account's route snapshots, progress and preferences |
| PATCH | /api/preferences | Optional target, goal_text, recents, navigation_collapsed |
| PUT | /api/progress | `{version,node_id,index,done}`; current version only |
| GET | /api/sources | Account's saved document metadata |
| POST | /api/sources | `{title,text}`; immutable, deduplicated per-account raw source |
| POST | /api/sources/{id}/analyze | Actual model request, validate output, save review plan |
| GET | /api/imports | Last 30 processing/ready/failed/applied batches |
| POST | /api/imports/{id}/apply | `{acknowledge:true}`; validate base version and commit new snapshot |
| POST | /api/mentor | `{node_id,question}`; answer plus source references |

Errors use `{detail: string}` or Pydantic validation detail. Missing authentication is 401, missing/wrong CSRF or foreign Origin is 403, nonexistent or foreign-account resource is 404, stale/read-only state is 409, invalid graph/model contract is 422, provider failure is 502, model not configured is 503. No endpoint returns provider credentials.
