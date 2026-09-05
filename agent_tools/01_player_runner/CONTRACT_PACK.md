# Player Runner 최소 Contract Pack

이 패키지는 게임을 해석하거나 채점하지 않는다. 합성 Canvas와 주입된 InputSink를 대상으로 화면 제공, 제한 입력, 감사 receipt, 공개·비공개 봉인만 담당한다.

## 허용된 지식

- Runner는 raw seed 대신 해석할 수 없는 `configHandle`만 보관한다.
- `campaignId`, `publicRunId`, `targetRunId`, signed artifact ID와 nonce는 Coordinator가 미리 발급한 identity pool에서만 소비한다. Runner는 이 값을 자체 생성하지 않는다.
- `runId`, `frameId`, `actionId`, `optionRef`는 실행 범위의 불투명 식별자다.
- 에이전트는 URL, DOM selector, 좌표, 파일 경로, 임의 키 문자열을 제출할 수 없다.
- 실제 safe point는 신뢰된 Resolver와 Judge용 private transcript에만 존재한다.

## 입력 불변식

1. 입력은 최신 served frame과 유효한 scope capability에만 허용한다.
2. request payload를 WAL에 먼저 동기화한 뒤 InputSink를 호출한다.
3. 동일 request와 payload는 저장된 receipt를 반환하며 다시 입력하지 않는다.
4. 동일 request에 다른 payload는 hard fail이다.
5. `NOT_DELIVERED`는 새 request가 필요하고, `DELIVERY_UNKNOWN`은 재입력을 금지한다.
6. dispatch 직후 중단되어 terminal WAL이 없으면 복구 시 `DELIVERY_UNKNOWN`으로 봉인한다.

## 로컬 도구 표면

`PlayerRunnerService`는 다음 exact-key 도구만 제공한다.

- `attach_run({ launchTicket })`
- `observe({ observeCap })`
- `tap_key({ keyboardCap, requestId, expectedFrameId, code })`
- `activate_option({ objectCap, requestId, expectedFrameId, optionRef })`
- `wait_frame({ observeCap, afterFrameId, maxFrames })`
- `bookmark_observation({ bookmarkCap, frameIds, precedingActionIds })`
- `request_end({ handoffCap, reason })`
- `seal_handoff({ handoffCap })`

모든 schema는 `additionalProperties: false`이며 raw `x/y`, URL, selector, DOM, click/press/navigate 계열 필드는 exact schema 검사 전에 거부한다. `tap_key.code`는 campaign 고정 allowlist의 하위 집합만 허용한다. `observe.options`의 각 원소에는 `optionRef`만 존재한다.

서비스는 게임 의미를 해석하지 않는다. 신뢰 경계 안에서 주입된 adapter의 `launch`, `capture`, `compose`, `dispatch`, `end`만 호출하고, agent-facing 호출에는 adapter session이나 safe point를 노출하지 않는다.

## stdio transport

외부 의존성 없는 newline-delimited JSON-RPC transport는 `initialize`, `tools/list`, `tools/call`, `ping`을 처리한다. `notifications/initialized`를 포함한 JSON-RPC notification은 응답하지 않는다. 이미지 바이트는 MCP 스타일 base64 image content로 반환하며 stdout에는 protocol JSON만 쓴다. 운영자가 제공한 trusted ESM bootstrap은 `createPlayerRunnerService()`를 export해야 한다.

```powershell
$env:ATLAS_RUNNER_BOOTSTRAP = 'C:\trusted\runner-bootstrap.mjs'
npm run stdio
```

bootstrap 경로는 로컬 운영 설정이며 agent tool 인자가 아니다.

## 프레임·객체 행동 불변식

- raw 캡처 사실은 `PrivateFrameReceipt`, 에이전트에게 실제 전달한 사실은 `SignedFrameServedEvent`로 각각 서명하며 공개 frame마다 정확히 하나씩 존재해야 한다.
- 두 frame 증거는 campaign/internal/public run, build handle, capture policy, overlay compositor·primitive digest, raw/served hash와 이전 frame receipt를 결속한다.
- option은 한 frame, 한 capability, 한 번의 예약에만 유효하다.
- 공개 객체 행동은 `opaqueActivate`만 남기며 option, target, safe point는 제거한다.

## 입력 receipt 결속

- `SignedInputReceipt`는 campaign/internal/public run, canonical request digest, 입력 전 private frame receipt digest와 이전 input receipt digest를 서명한다.
- outcome settle event는 입력 receipt와 모든 입력 후 private frame receipt digest를 서명한다.

## 출력 경계

- 공개 handoff는 공용 프로토콜 allowlist payload로 처음부터 새로 만들고 `PublicPlayHandoff` signed envelope로 반환한다.
- `PublicPlayHandoff.header.targetRunId`는 `manifest.runId`와 같아야 한다. 서비스는 둘이 다른 Coordinator identity pool을 시작 전에 거부한다.
- signed envelope의 `header.schemaVersion`은 generic wrapper 버전이 아니라 payload schema를 결속한다. Public은 `atlas/public-play-handoff/1`, private Judge는 `atlas/private-judge-envelope/1`이며, 유효한 키로 서명됐더라도 다른 header schema는 저장/import하지 않는다.
- 공개 데이터는 served frame, 공개 observation 참조, 공개 action receipt만 포함한다.
- private Judge envelope는 config/build handle, signed frame/input transcript와 replay adapter version을 가진다.
- raw seed, canonical truth, capability, option mapping, 좌표, 절대 경로는 공개할 수 없다.
- 모든 public/private envelope header는 `campaignId`, `track: EXPLORATION`, `arm: NONE`, `targetRunId`를 포함한다.

## 영속 저장

- `HandoffSealer.publicFiles`는 manifest에 선언된 모든 frame PNG, `observations.ndjson`, `actions.ndjson`를 정확히 한 번씩 포함하며 byte 길이와 SHA-256을 봉인 전에 검증한다.
- `PlayerRunnerService`에 trusted `artifactStore`가 주입된 경우 `persist({ publicHandoff, publicFiles, privateJudgeEnvelope })`가 성공한 뒤에만 상태가 `SEALED`가 된다. 저장 실패는 `INVALID`이며 메모리 artifact도 공개하지 않는다.
- `FileArtifactStore`의 public/private root는 constructor 전용 trusted 설정이다. 두 root는 분리·비중첩이어야 하며 agent 도구 인자로 경로를 받지 않는다.
- public 파일명은 manifest 소유의 `frames/FNNNNNN.png`, `observations.ndjson`, `actions.ndjson`와 store 소유 `handoff.json`만 허용한다. private에는 `private-envelope.json`만 쓴다.
- 각 artifact는 같은 root 아래 임시 디렉터리에 쓴 뒤 rename하며, 기존 최종 대상은 덮어쓰지 않는다. AI의 `seal_handoff` 응답에는 경로나 private 저장 상세를 넣지 않는다.
