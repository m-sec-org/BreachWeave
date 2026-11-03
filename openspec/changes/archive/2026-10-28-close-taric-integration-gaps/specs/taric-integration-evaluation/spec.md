# Spec Delta

## Purpose

Make Taric integration and outcome claims traceable to repository evidence or reproducible runs, and avoid attributing quality changes to an uncontrolled single task.

## ADDED Requirements

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
