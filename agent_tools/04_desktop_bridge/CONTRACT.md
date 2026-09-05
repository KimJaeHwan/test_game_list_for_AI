# Desktop Bridge Contract v1

This contract is the only shared implementation context for the Windows desktop bridge modules. The bridge observes composited GUI pixels and delivers bounded OS input. It must not inspect DOM, accessibility trees, process memory, game state, network traffic, or application-specific APIs.

## Trust boundary

- Window titles, process identifiers, executable paths, HWND values, screen bounds, and native errors are private operator data.
- The untrusted caller may receive only a PNG frame, an opaque frame ID, opaque option references, allowed key names, and public delivery state.
- The operator selects a target. The untrusted caller cannot select or change it.
- The trusted bootstrap selects capture and input providers. No Runner action, public request, or native NDJSON request can select or replace a provider.
- `TargetBindingBroker.withPrivateBinding(targetRef, callback)` is the common JS gate for capture and input. It inspects the selected HWND immediately before the callback and releases the private `{targetIdentity,region}` only when every pinned identity and client-geometry field still matches.
- The native bridge independently revalidates identity, geometry, visibility, minimization, foreground state, and the relevant composited/hit-test conditions before its primitive call. A JS revalidation is not a substitute for this native guard.
- Input is refused unless the target is visible, not minimized, and is the foreground window.
- Absolute desktop coordinates never cross the native bridge boundary.
- Provider failure never triggers an automatic fallback. A provider change requires ending the current session, closing its provider lifecycle, an operator rebind and new launch, and a new applicable policy attestation.

## Native NDJSON protocol

The native helper reads one JSON object per stdin line and writes exactly one JSON object per stdout line. Diagnostics go to stderr.

All requests contain `id` and one exact `op`:

- `listWindows`: enumerate visible top-level windows for the trusted operator.
- `inspect`: return the current private identity and client geometry of one HWND.
- `capture`: verify a binding and capture a bound client-relative region as PNG.
- `tapKey`: verify a binding and deliver one allowlisted key tap.
- `safeClick`: verify a binding and click one client-relative point that lies inside the bound region.

Successful responses have `{ "id", "ok": true, "result" }`. Failures have `{ "id", "ok": false, "error": { "code", "message" } }`. Response objects contain no additional fields.

### Target identity

```json
{
  "hwnd": "decimal-string",
  "pid": 123,
  "processStartTimeUtc": "ISO-8601",
  "executableSha256": "64-lowercase-hex",
  "clientWidth": 1280,
  "clientHeight": 720
}
```

The executable path may be shown by `listWindows` to the trusted operator but is not part of any public artifact. A binding pins the fields above. Geometry changes invalidate the binding and require an operator rebind.

### Region and pixels

`region` is client-relative `{x,y,width,height}` with integer values, positive dimensions, and full containment in the pinned client rectangle. `capture` returns `{pngBase64,width,height,captureBackend}`. The implementation captures the pixels currently composited on screen. Occlusion, lost foreground, minimization, bounds changes, or capture failure must fail closed rather than returning another application's pixels.

### Input

`tapKey` accepts only the fixed common campaign codes: `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Enter`, `Tab`, `Space`, `Shift`, `KeyA`, `KeyB`, `KeyC`, `KeyD`, `KeyE`, `KeyF`, `KeyN`, `KeyR`, `Digit1`, `Digit2`, `Digit3`, and `Digit4`. `safeClick` accepts a private client-relative point produced by the trusted option resolver. The helper validates the point against the bound region immediately before delivery. It does not activate, focus, navigate, or retarget a window on behalf of a request.

The native implementation separates the common Windows guard from two internal primitive interfaces:

- `IFrameCaptureBackend`: exposes a stable `BackendId` and captures one already-validated screen region as PNG bytes.
- `IInputBackend`: exposes a nonsemantic `SinkReceipt` and performs one key tap or click, returning `Delivered`, `NotDelivered`, or `DeliveryUnknown`.

Backends receive only validated private values. They must not inspect the target, focus or retarget a window, retry, or choose another backend. The current production defaults are `GdiFrameCaptureBackend` (`gdi-composited-screen/v1`) and `SendInputBackend` (`win-sendinput`).

## Stable JS provider contracts

The adapter does not receive a raw native bridge. Trusted composition injects independent providers into brokers, and a lifecycle closes their underlying resources at most once.

### `CaptureProvider`

The descriptor is exactly `{providerId,capture}`. `providerId` is a non-secret stable identifier containing 1–128 allowlisted token characters. `capture({binding,region})` is invoked at most once, only inside `TargetBindingBroker.withPrivateBinding`, and returns exactly:

```js
{ rawBytes, width, height, providerId }
```

`rawBytes` must be a structurally complete PNG; dimensions must equal the pinned region; and the returned `providerId` must equal the descriptor. `CaptureBroker` exposes only sanitized broker failures (`CAPTURE_TARGET_REVALIDATION_FAILED`, `CAPTURE_PROVIDER_FAILED`, `CAPTURE_RESULT_INVALID`, or closed state) and never falls back to another provider.

### `InputProvider`

The stable capability is `dispatch(action, pinnedTarget)`. `SafeInputBroker` passes only an exact private action and the freshly revalidated private `{targetIdentity,region}`. A provider returns exactly:

```js
{
  status: "DELIVERED" | "NOT_DELIVERED" | "DELIVERY_UNKNOWN",
  sinkReceipt: "nonsemantic-token"
}
```

The provider descriptor has no public `providerId` field in v1; only its `dispatch` capability is consumed. `sinkReceipt` is a bounded nonsemantic token, not target metadata. Policy rejection and failure before provider invocation are `NOT_DELIVERED`. A thrown provider error, malformed result, transport ambiguity, or any uncertainty after invocation is `DELIVERY_UNKNOWN`. Neither status is retried automatically, and especially an unknown outcome must never be retried.

`createLegacyBridgeCaptureProvider` and `createLegacyBridgeInputProvider` are deliberate migration adapters for `NativeDesktopBridgeClient`; new composition must inject the stable contracts directly. They are not fallback chains.

## Node module boundaries

- `native/**`: low-level Windows enumeration, pixel capture, binding checks, and OS input only.
- `src/targeting/**`: operator-only candidate listing, one-time launch tickets, opaque target binding, and revalidation.
- `src/provider-contract.mjs` and `src/capture/**`: stable capture-provider validation, one-shot capture, PNG validation, and provider lifecycle.
- `src/input/**`: fixed key policy and safe-point delivery policy only.
- `src/desktop-window-adapter.mjs` and `integration/**`: compose already-validated brokers into the existing Player Runner API; they do not choose providers from untrusted input.
- `scripts/**`: operator-only enumeration and live smoke orchestration.

No module may import the CDP adapter or application-specific code.

## Provider replacement rules

A different Windows API may be introduced only behind the corresponding stable JS provider and native backend interface. Selection belongs to trusted operator/bootstrap configuration, is fixed for a session, and must never be data-driven by the Agent. The current repository has no public runtime provider-selection switch: its GDI and SendInput defaults are fixed in trusted composition/native code. Any future switch must remain operator-only. Do not silently fall back within a capture or delivery attempt.

Before enabling a replacement, end and close the old session, select the provider in trusted composition, rebind the target, issue a fresh one-time launch ticket, and start a new session. The capture provider ID is included in `capturePolicyDigest`, so changing it produces a new digest. Input v1 exposes `inputPolicyVersion` rather than an input-provider ID; changing delivery semantics requires bumping `DESKTOP_INPUT_POLICY_VERSION` before launch so the new session carries a distinct policy attestation.
