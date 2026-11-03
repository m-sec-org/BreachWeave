# taric-authoritative-control-plane Specification

## Purpose
Define Taric as the recoverable authority for authorized-pentest work and the source from which BreachWeave can rebuild governance state and disposable projections.

## Requirements

### Requirement: Governed projects bind an exact Taric contract

An authorized project SHALL bind to a trusted Taric authority, Engagement, principal policy, and exact supported contract before any governed operation. Unsupported versions, source digests, schema, storage, SQL, or policy digests SHALL block governed startup.

#### Scenario: The pinned Taric contract matches
- **WHEN** a local-development project starts with the pinned Taric source and contract tuple
- **THEN** the host records the validated binding and may expose only the operations allowed for that principal

#### Scenario: Taric contract or digest is mismatched
- **WHEN** the authority reports an unsupported version or a source, schema, storage, SQL, or policy digest differs
- **THEN** the host blocks governed startup before creating or mutating task state and returns a bounded diagnostic

### Requirement: Authorized scope and ROE revisions are canonical Taric state

An authorized project SHALL resolve or provision its Scope/ROE in Taric before creating governed Coverage or Work state. The host SHALL persist the stable Scope identifier and immutable revision identifier in the project binding, verify the setup digest against the authority response, and use that revision for egress, Coverage, checkpoints, action audit, and report snapshots. A local scope file or caller-provided policy SHALL NOT be an alternate authority.

#### Scenario: A scope revision is provisioned
- **WHEN** an authorized project is initialized with a Scope/ROE input and no matching canonical revision
- **THEN** the host creates or resolves the Taric Scope/Revision idempotently, records the returned identifier and digest, and only then exposes governed operations

#### Scenario: Scope authority cannot be resolved
- **WHEN** the Scope/ROE record, revision, digest, or bound Engagement cannot be read from Taric
- **THEN** `taric_required` blocks governed startup and target actions instead of using the local setup scope

#### Scenario: A Scope/ROE revision changes
- **WHEN** a newer canonical Scope/ROE revision is activated
- **THEN** the host invalidates affected WorkRuns and Coverage cells, binds subsequent action and report records to the new revision, and rejects close candidates based on the old revision

### Requirement: Governance identifiers and recovery locators survive projection deletion

The host SHALL derive and persist idempotent identifiers that map a project to an Engagement and Scope, each challenge asset to a Resource and Revision, coverage dimensions to Coverage cells, and accepted work to WorkItems, WorkRuns, Attempts, and task sessions. The mapping ledger and recovery locator SHALL be canonical Taric metadata or deterministic derivations from canonical Taric records; process-local maps SHALL be caches only.

#### Scenario: A project asset is provisioned more than once
- **WHEN** the host retries provisioning the same project and asset with the same identity inputs
- **THEN** it resolves the same Taric identifiers without creating duplicate canonical objects

#### Scenario: A caller supplies an identifier outside its binding
- **WHEN** a model or API caller substitutes a project, Resource, Engagement, or principal identifier
- **THEN** the host rejects the request before forwarding it to Taric

#### Scenario: Disposable host projections are deleted
- **WHEN** challenge JSON, manifest copies, session state, snapshots, and process-local maps are deleted
- **THEN** the host reconstructs the project binding, Scope/ROE revision, Resource/Revision, Coverage cells, Work locators, and report inputs from Taric state without trusting caller-supplied identifiers

### Requirement: Only admitted work is claimable

The host SHALL make authorized WorkItems queryable only after the approved proposal and admission flow completes, and SHALL claim work from a cursor-paginated query pinned to a fixed `read_seq`.

#### Scenario: A newly approved WorkItem is dispatched
- **WHEN** a WorkItem proposal is admitted and returned by a pinned `work.query`
- **THEN** the host may claim it and creates a WorkRun and Attempt bound to its Resource, Revision, owner, and generation

#### Scenario: A WorkItem is still a proposal
- **WHEN** a pending or rejected WorkItem proposal is offered to a worker
- **THEN** the host refuses to claim or launch it

### Requirement: Local authorized work uses Taric generation fencing

Every local authorized WorkRun SHALL use Taric claim, renew, transition, and generation fencing; BreachWeave SHALL separately reserve its worker slots and target resources.

#### Scenario: Two workers claim the same WorkItem
- **WHEN** concurrent workers attempt to claim one admitted WorkItem
- **THEN** Taric grants at most one active owner and the host launches no unfenced duplicate worker

#### Scenario: A stale generation reports a mutation
- **WHEN** an expired or superseded generation submits a transition, checkpoint, action result, or Artifact publication
- **THEN** the host rejects or quarantines the mutation without changing authoritative state

#### Scenario: WorkItems target the same exclusive resource
- **WHEN** separate valid WorkRuns request a host-defined exclusive target or tool reservation
- **THEN** the BreachWeave scheduler serializes or rejects the conflict independently of Taric `resource_refs`

### Requirement: Restart recovery is rebuilt from authority state

The host SHALL persist a recovery locator and the allowlisted checkpoint for each active task through the Taric Work/checkpoint contract and reconstruct run state from Taric queries before resuming execution; process-local governance maps and checkpoint files SHALL be disposable caches only.

#### Scenario: An active run resumes after process restart
- **WHEN** the host restarts and consumes the complete pinned query cursor for an active WorkRun
- **THEN** it validates the recovery locator and `work.resume` premise, then continues the same generation only when authority confirms it

#### Scenario: A lease is lost or expired
- **WHEN** an active run cannot resume under its current owner and lease
- **THEN** the host reclaims through Taric, marks the old Attempt lost, advances the generation, and rejects late writes from the old generation

#### Scenario: Recovery inputs are incomplete or invalid
- **WHEN** a cursor is incomplete, a premise fails, or no valid checkpoint exists
- **THEN** the host marks the run `blocked/replan_required` and does not launch from a local snapshot alone

#### Scenario: A recovery locator is resolved
- **WHEN** the host restores a work item after restart
- **THEN** its locator resolves the project, challenge, WorkItem, WorkRun, Attempt, generation, task session, and Pi session ID without trusting a caller-supplied identifier

#### Scenario: A checkpoint is restored
- **WHEN** an active run has an allowlisted checkpoint and the host process restarts
- **THEN** `work.resume` returns the checkpoint from authority state, the host verifies its Scope/ROE revision and generation, and no local-only checkpoint can authorize continuation

### Requirement: Context reads are bounded, pinned, and complete-or-explicitly-partial

The host SHALL build Planner and Solver context from bounded Taric Context, Work, Resource, and Coverage queries whose cursors are bound to principal, Engagement, filters, and a stable read watermark.

#### Scenario: A context query spans multiple pages
- **WHEN** Taric returns a next cursor for a query
- **THEN** the host follows the cursor within configured record, byte, and page budgets and exposes the common `read_seq`

#### Scenario: A context query has more than one page of records
- **WHEN** a project has more than 50 matching records
- **THEN** the host returns every record at most once across cursor pages or explicitly reports truncation and the cursor needed for refresh

#### Scenario: A cursor expires or a budget is reached
- **WHEN** a query cannot consume the pinned result completely
- **THEN** the host reports the result as stale, truncated, or blocked and never presents it as an empty complete result

#### Scenario: A notification is received
- **WHEN** the host receives, loses, duplicates, or reconnects after a Taric notification
- **THEN** it uses the notification only as a refresh hint and re-queries authority from the last confirmed watermark before changing trusted state

### Requirement: Local projections are disposable and reproducible

Web state, statistics, Planner snapshots, challenge `scanned` flags, challenge JSON/manifest copies, report indexes, session state, and governance maps SHALL be projections or caches; deleting them SHALL NOT change the authoritative task, Scope/ROE, checkpoint, action audit, coverage, report-reference, or close result.

#### Scenario: Local projection data is removed
- **WHEN** the host rebuilds a project after deleting its local snapshots and maps
- **THEN** Taric queries restore the same active work, Attempts, coverage gaps, evidence references, and report close decision

#### Scenario: Competition completion state is read
- **WHEN** a competition asset has `scanned` or a platform reports solved
- **THEN** those values do not create authorized-pentest coverage, findings, or Engagement closure

#### Scenario: Challenge files are deleted
- **WHEN** the local challenge and manifest files are unavailable after an authority-backed project was provisioned
- **THEN** Taric Resource/Revision, Scope/ROE, Coverage, Work, and report snapshot queries rebuild the governed inputs and produce the same close decision or an explicit incomplete-state diagnostic

### Requirement: Coverage and close use one authoritative snapshot

Authorized Coverage SHALL use stable, immutable manifest, Scope/ROE, and ResourceRevision dimensions, expected-version updates, evidence requirements, and a fixed read watermark; the gate SHALL expose decision, gaps, visibility, and that watermark. The host SHALL query and hash the authoritative Evidence set at that watermark, commit the report Artifact through the Taric Artifact contract, and persist the close decision as an authority record bound to the same gate and evidence snapshot.

#### Scenario: Coverage is recorded without evidence
- **WHEN** a positive Coverage result has no canonical Evidence or `not_applicable` has no reason
- **THEN** the cell remains a gate gap and cannot make the Engagement closable

#### Scenario: A report is closed
- **WHEN** the host closes an authorized Engagement
- **THEN** it binds the decision to the Engagement, Scope/Resource revisions, manifest digest, gate `read_seq`, Evidence snapshot hash, and report Artifact digest

#### Scenario: State changes after the gate query
- **WHEN** evidence, work, coverage, Resource, or Scope state advances beyond the gate watermark
- **THEN** the host invalidates the close candidate and refreshes the gate and report snapshot

#### Scenario: A report snapshot is rebuilt after restart
- **WHEN** local report indexes and snapshots are deleted after a gate query
- **THEN** the host re-reads the pinned gate and Evidence cursor, resolves the committed report Artifact reference, and obtains the same snapshot digest or an explicit stale/incomplete result

#### Scenario: A shared Engagement contains multiple projects
- **WHEN** an Engagement-level Coverage gate includes cells mapped to more than one local project
- **THEN** the host applies its trusted project-to-cell mapping to the pinned query and does not treat the whole Engagement gate as one challenge's completion result

#### Scenario: Coverage dimensions are changed
- **WHEN** a caller attempts to mutate a Coverage cell's stable dimensions after creation
- **THEN** the host rejects the update and requires a new cell under the changed manifest or ResourceRevision

### Requirement: Proposal trust levels remain distinct

The host SHALL distinguish model candidates (L0), admitted canonical records (L1), and independently verified findings (L2) in projections and audit state; one level SHALL NOT imply the next.

#### Scenario: A local fixture host reviews a candidate
- **WHEN** a fixture host evaluates a model candidate in local development
- **THEN** the host records the admission decision and Evidence basis as local fixture evidence

#### Scenario: A record is independently verified
- **WHEN** a finding has passed the configured independent verification process
- **THEN** the host records the separate L2 evidence and does not infer it from `review.submit`, admission, or `IdeaStatus.verified`
