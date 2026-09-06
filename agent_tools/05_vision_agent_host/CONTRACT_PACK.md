# Vision Agent Host Contract Pack

This package contains a game-agnostic, keyboard-only supervisor boundary.

## Public ports

    interface ModelPort {
      decide(input: {
        prompt: string;
        imagePath: string;
        schemaPath: string;
        outputPath: string;
        workdir: string;
      }): Promise<{
        action: ModelAction;
        threadId?: string;
        usage?: {
          inputTokens: number;
          cachedInputTokens: number;
          outputTokens: number;
        };
      } | ModelAction>;
      resetSession(): {
        status: "RESET";
        nextInvocation: "EXEC";
        sessionGeneration: number;
      };
      rotateSession(): {
        status: "ROTATED";
        nextInvocation: "EXEC";
        sessionGeneration: number;
      };
    }

    interface RunnerPort {
      attachRun({ launchTicket }): Promise<AttachResult>;
      observe({ observeCap }): Promise<Frame>;
      tapKey({ keyboardCap, requestId, expectedFrameId, code }): Promise<InputReceipt>;
      waitFrame({ observeCap, afterFrameId, maxFrames }): Promise<Frame>;
      bookmarkObservation({ bookmarkCap, frameIds, precedingActionIds }): Promise<object>;
      requestEnd({ handoffCap, reason }): Promise<object>;
      sealHandoff({ handoffCap }): Promise<object>;
      close(): Promise<void>;
    }

ModelAction is exactly one of press_key, refresh_frame, bookmark, or finish. Unknown fields, raw coordinates, URLs, selectors, arbitrary key strings, multiple actions, and object activation are forbidden.

`resetSession()` is a one-shot recovery primitive, not a retry. It accepts no arguments and is eligible only immediately after an exact `MODEL_TURN_FAILED`, once the model child has closed and the port is idle and uncancelled. It clears the retained thread, increments a safe non-negative session generation, and returns only the exact receipt shown above. The next decision uses fresh `codex exec`; later decisions resume only the new thread. A success, any other error, a completed reset, or an unsafe reset attempt clears eligibility. Unsafe calls fail as `MODEL_SESSION_RESET_UNSAFE` and expose no thread id, path, or raw diagnostic.

`rotateSession()` is a distinct one-shot normal-session boundary. It accepts no arguments and is eligible only immediately after a successful `decide()` while the port is idle, uncancelled, child-free, and retaining a valid thread id. It clears that thread, increments the shared safe session generation, and returns only the exact `ROTATED` receipt shown above. The next decision is a fresh `exec` and later decisions resume the replacement thread. Calls before success, during a turn, after failure, with arguments, or after the eligibility has been consumed fail as `MODEL_SESSION_ROTATION_UNSAFE`. Rotation never grants reset eligibility or authorizes a model call by itself.

For Codex JSONL `error` and `turn.failed`, `ModelPortError.codexErrorInfo` is an own, read-only property whose value is an exact frozen `{ category, httpStatus, retryable }` projection. Only enumerated provider categories and camel/snake aliases are accepted; HTTP status is `null` or an integer from 100 through 599. Unknown, conflicting, additional, or malformed diagnostic shapes project to `UNAVAILABLE/null/false`. Raw provider messages, additional details, prompts, thread/turn identifiers, paths, and stderr are never copied into the error. The projection is audit telemetry only and cannot broaden reset, rotation, or automatic-call policy.

The Supervisor may use this primitive at most once per run (default `modelRestarts: 1`, operator may set `0`, values above `1` are invalid). It first requires `DECIDING`, a quiescent model, a healthy journal, no pending mutation, unchanged key attempts, the same FrameStore record, canonical regular non-symlink PNG bytes with a matching SHA-256, and remaining turn and elapsed budgets. It records sanitized `model_restart_authorized`, validates the exact reset receipt, then records `model_session_reset` before a second model call. Any audit, reset, receipt, frame, or state failure quarantines without another call; only a second exact `MODEL_TURN_FAILED` or exhausted restart/turn/elapsed budget follows the existing recoverable PARTIAL seal.

`policyProfile` is exactly `DEFAULT` or `ROLLOVER_ENDURANCE_2X`. `DEFAULT` keeps the legacy ceilings and result shape. `ROLLOVER_ENDURANCE_2X` has fixed ceilings of 120 turns, 60 keys, 180 observations, and 2,700,000 elapsed milliseconds; every other ceiling is inherited from `DEFAULT`. Explicit policy values and trusted Runner budgets may only reduce the selected ceiling. The profile does not change the model prompt, cannot force a finish action, and never exposes its name, token threshold, target, completed count, or validated count to the model.

After every successful proactive rotation, the Supervisor retains a pending validation bound to the rollover ordinal, shared session generation, next turn, and exact verified frame id/SHA-256. A failed successor model call, usage validation, or action validation discards it. After the next action validates, the normal exact `frame_served -> model_turn_usage -> decision` journal sequence remains intact; before any selected side effect, the Supervisor rechecks the pending boundary and stored frame, then appends exact `model_rollover_validated { rolloverOrdinal, sessionGeneration, turn, frameId, frameSha256 }`. Only a successful audit increments the validated endurance count. Audit or boundary failure quarantines before a Runner side effect.

Only `ROLLOVER_ENDURANCE_2X` results add `executionProfile: "ROLLOVER_ENDURANCE_2X"`, `primaryScoreEligible: false`, and `rolloverEndurance { thresholdInputTokens: 55000, target: 2, completed, validated, requirementMet, status }`. Completed and validated counts include only rotations whose completed predecessor reported at least the fixed threshold. `requirementMet` is true, and status is `PASS`, only after two completed rotations each have a valid successor action; otherwise status is `INSUFFICIENT_DURATION`. An early model-selected finish remains a normal finish and is reported as insufficient rather than being delayed or replaced.

The Supervisor-facing schema may express this compact union. A provider adapter must not forward a root union to OpenAI Structured Outputs. It creates a strict root object whose only required property is `action`; that property contains a nested `anyOf` of exact action objects. Every object requires all properties it declares and sets `additionalProperties:false`. Each branch contains only its active fields, and the `press_key` branch is omitted when no keys are allowed. Unsupported `uniqueItems` is not sent; duplicate frame ids remain a local fail-closed validation. Legacy flat/null envelopes and additional fields are rejected without normalization. Schema and output paths are canonical direct children of the private model workdir; the adapter removes only the provider schema it exclusively created.

## Mandatory invariants

- A model turn dispatches at most one key mutation.
- DELIVERED is followed by waitFrame before the next decision.
- NOT_DELIVERED is followed by a new observation and a new decision, never an automatic resend.
- Unknown delivery, mutation timeout, protocol desynchronization, invalid model output, or forbidden Codex tool events quarantine the run.
- No key mutation occurs after quarantine.
- Every image sent to the model is persisted with its verified frame id and SHA-256.
- Every bookmark frame id matches `^F\\d{6}$` independently in both the model adapter and Supervisor.
- Capabilities and target metadata never enter the model prompt or driver journal.
- Finish requires two reserved handoff calls.
- Model usage is a validated per-turn delta. Missing usage remains missing; cached input is not added again, and monetary cost is not inferred.

Only synthetic PNGs and fake ports belong in public conformance fixtures. Do not include application names, content strings, seeds, truth data, scoring, Wiki/Judge code, target handles, or production credentials.
