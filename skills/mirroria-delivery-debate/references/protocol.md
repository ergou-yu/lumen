# Mirroria Delivery Debate Protocol

## State machine

`intent.locked → executor.assigned → artifact.changed → evidence.submitted → review.started → review.accepted → run.completed`

For a response-only `quick` task that legitimately triggered this skill but needs neither file changes nor adversarial review:

`intent.locked → responder.assigned → answer.produced → evidence.checked → run.completed`

For a high-stakes conclusion or user-requested adversarial review that needs no file change:

`intent.locked → responder.assigned → answer.produced → evidence.submitted → review.started → review.accepted → run.completed`

Ordinary low-risk conceptual questions bypass this skill and answer directly. Do not assign a file executor, open a debate, scan a workspace, or fabricate an artifact for them.

When review blocks:

`review.blocked → repair.assigned → artifact.changed → evidence.delta → review.started`

Terminal failure states:

- `run.blocked`: the task needs new authority, credentials, unavailable hardware, or another user decision.
- `run.failed`: the selected connector or executor failed and in-scope recovery paths are exhausted.

Never transition from `review.blocked`, `artifact.missing`, `executor.noop`, `answer.missing`, or `evidence.missing` directly to `run.completed`.

## Coordinator contract

```json
{
  "goal": "Concrete user outcome",
  "workspace": "/absolute/path",
  "requires_file_changes": true,
  "deliverables": [{"kind": "file", "path": "/absolute/path/to/output"}],
  "acceptance": ["Observable criterion"],
  "constraints": ["Actual user or safety constraint"]
}
```

For a response-only contract, use `workspace: null`, `requires_file_changes: false`, and `deliverables: [{"kind":"response"}]`.

Lock the contract after minimal read-only preflight. If discovery narrows a directory or pattern to exact files, emit an evidence-backed amendment:

```json
{
  "event": "contract.amended",
  "field": "deliverables",
  "before": [{"kind": "file-set", "path": "/absolute/path", "match": "documented pattern"}],
  "after": [{"kind": "file", "path": "/absolute/path/to/discovered-file"}],
  "evidence": "read-only command and result that discovered the exact scope"
}
```

An amendment may only refine the deliverable file list. Preserve the original goal, acceptance meaning, user constraints, and requested outcome; never use refinement to add work or weaken a gate.

## Executor handoff

```json
{
  "summary": "What was actually changed",
  "changed_files": [
    {"path": "/absolute/path", "evidence": "diff or content hash; mtime may appear only as freshness metadata"}
  ],
  "checks": [
    {"command": "exact command", "exit_code": 0, "result": "short output"}
  ],
  "acceptance_evidence": [
    {"criterion": "criterion text", "evidence": "file or check reference"}
  ],
  "uncertainties": []
}
```

For a response-only handoff, omit `changed_files` and provide answer evidence instead:

```json
{
  "summary": "Answer produced",
  "checks": [{"method": "self-check, source, or calculation", "result": "short result"}],
  "acceptance_evidence": [
    {"criterion": "criterion text", "evidence": "answer, source, or calculation reference"}
  ],
  "uncertainties": []
}
```

Do not use `mtime` as proof of a file change. A file-delivery handoff without a diff or content hash is incomplete.

## Critic response

```json
{
  "verdict": "ACCEPT | BLOCK",
  "issues": [
    {
      "severity": "blocking | warning",
      "claim": "Falsifiable defect",
      "evidence": "Observed file or check result",
      "required_fix": "Smallest action that resolves it"
    }
  ]
}
```

## Progress gate

Count a debate cycle as productive only if at least one of these changes:

- artifact content or file set;
- command/test evidence;
- an acceptance criterion's state;
- a critic issue is added with new evidence or resolved with new evidence.

If none changes, do not schedule another debate message. Assign a concrete tool/file action or stop with the correct blocked state.

Response-only `quick` tasks do not enter this debate gate. For non-file adversarial review, treat answer content, claim evidence, or an acceptance criterion's state as the evidence-bearing change.

After two substantive repair attempts, the coordinator may dismiss a critic issue only when new evidence proves it false or outside the locked contract. Record that evidence and ruling. If a blocking issue remains valid, reassign a concrete repair or end in `run.blocked`/`run.failed`; never vote it away or transition to `run.completed`.

## Public activity rules

Display only public work descriptions and tool activity:

- reading or searching files;
- editing named files;
- running a named check;
- searching the web;
- waiting for a provider, elapsed time, and reconnection attempts;
- submission, review issue, repair, and final verification.

Coalesce repeated heartbeats into one live activity row. Do not display hidden chain-of-thought or private reasoning tokens.
