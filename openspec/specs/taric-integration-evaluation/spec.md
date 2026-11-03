# taric-integration-evaluation Specification

## Purpose
Make Taric integration and outcome claims traceable to repository evidence or reproducible runs, and avoid attributing quality changes to an uncontrolled single task.

## Requirements

### Requirement: Runtime claims identify their evidence class

Every implementation or operational report SHALL distinguish source-verifiable facts, automated test results, deployment observations, and hypotheses. Run-specific counts may include a local log or profile note when available. Missing artifacts should be described as unavailable rather than reconstructed from code assumptions.

#### Scenario: A run report claims observation failures

- **WHEN** a report states a capture count or failure rate
- **THEN** it records the available local diagnostic or marks the value as an observation without evidence

#### Scenario: A health probe is successful

- **WHEN** a run report records healthy Taric status
- **THEN** it reports health separately from the operation result when that detail is available

### Requirement: Taric outcome comparisons are controlled and repeated

Claims about Taric task outcomes SHOULD use comparable runs when the environment supports them. A local smoke run or unmatched run is valid implementation feedback and SHALL be described as an observation rather than a causal benchmark result.

#### Scenario: A paired comparison is run

- **WHEN** legacy and Taric modes are evaluated against the same benchmark inputs
- **THEN** the report records the available controls and outcomes and identifies the comparison as descriptive unless repeated controls are present

#### Scenario: A single run is available

- **WHEN** only one Taric run or an unmatched baseline exists
- **THEN** the report describes observed behavior without claiming a quality effect

### Requirement: Evaluation includes integration-specific reliability and reuse metrics

The evaluation MAY report operation-specific capture success/failure, query completeness, outbox status, coverage, recovery, evidence traceability, task outcome, and resource cost. When metrics are reported, state the available denominator and profile. No score SHALL combine distinct competition Flag, local `scanned`, and authorized coverage semantics.

#### Scenario: Observation capture is evaluated

- **WHEN** capture reliability is reported
- **THEN** the available attempted and result counts are recorded by source type and Taric profile

#### Scenario: Completion is summarized across modes

- **WHEN** outcomes include competition and authorized-pentest tasks
- **THEN** platform solve, local report coverage, and authorized coverage/close are reported as separate measures

### Requirement: Conformance reports identify the evidence class and profile

Every phase SHALL produce a machine-readable report that identifies whether each result is upstream Taric test, BreachWeave automated test, host conformance, local fixture smoke, or real gateway smoke, and SHALL name the authority and acceptance profile used.

#### Scenario: A local feature check passes

- **WHEN** a local-development test verifies Artifact recovery or WorkRun fencing
- **THEN** the report labels it as BreachWeave test or local fixture evidence

#### Scenario: A phase completes
- **WHEN** a P0-P4 implementation phase is reported complete
- **THEN** its report records the pinned source digest, profile, check results, and unavailable evidence without mixing upstream and host test claims

#### Scenario: A local capture smoke completes
- **WHEN** the selected fixture smoke submits the supported solver, attempt, and report capture events
- **THEN** each confirmed smoke event is accepted exactly as the operation contract allows, duplicate or ambiguous outcomes are reported separately, and validation errors identify their operation and bounded cause

### Requirement: Governance metrics keep completion domains separate

Evaluation SHALL report contract, isolation, paging, WorkRun, recovery, Evidence, Coverage, Action, and projection-rebuild metrics with their denominator and profile; competition solved, local `scanned`, and authorized close SHALL never be combined into one score.

#### Scenario: Capture reliability is measured

- **WHEN** a report summarizes observation or Artifact capture
- **THEN** it states attempted, accepted, rejected, deferred, indeterminate, and reconciled counts by source type and Taric profile

#### Scenario: A single smoke run is available

- **WHEN** only one unmatched challenge or model run exists
- **THEN** the report describes observed behavior and limitations without claiming a causal quality improvement or release benchmark

### Requirement: Missing operational artifacts remain explicitly unavailable

Run-specific claims SHALL link sanitized logs, queries, or machine-readable reports when available; absent artifacts SHALL be marked unavailable or unverified rather than inferred from source code or a different challenge.

#### Scenario: A run count has no durable artifact

- **WHEN** an operator reports a count without a reproducible log or query export
- **THEN** the report labels it as an observation with missing evidence and does not use it as a conformance gate
