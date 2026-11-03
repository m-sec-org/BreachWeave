# Taric Real Integration Smoke (2026-10-28)

The OrbStack-backed authenticated proxy was exercised against the running local gateway at `127.0.0.1:8849`. The target was the user-authorized DVWA endpoint `http://10.5.207.26:4280/`; the smoke itself only submitted sanitized observation statements and did not store credentials or raw responses.

The host used a trusted operator-provisioned Resource and ran the BreachWeave Taric host module with `taric_required`. Taric health was `healthy` before dispatch. Three operation-specific observations were accepted: `tool_result` for the solver event, `host_event` for the attempt event, and `platform_result` for the report event. A proposal query-back returned all nine observations accumulated by this smoke series. A statement containing a Bearer credential was rejected locally before dispatch, proving the redaction boundary.

The Resource was intentionally not visible in the model projection returned by `resource.query`; that is the expected trust and role projection for the shared authority. The accepted operation results and proposal query-back are the authoritative smoke evidence. The machine-readable result is [docs/artifacts/taric-real-integration-smoke.json](artifacts/taric-real-integration-smoke.json), digest `sha256:f27166fb03c8c75905e1076c6b5022cacf314e3ee2e633d412ff364e72c0644f`.

This records the authenticated-proxy portion of OpenSpec task 1.7. Bun embedded is not declared as a supported deployment profile in the current verification report, so no embedded claim is made. Project-bound Engagement provisioning, network egress interception, scheduler WorkRun wiring, durable Taric Artifact storage, role-separated review, and durable close/recovery remain optional hardening work for stronger deployment profiles.
