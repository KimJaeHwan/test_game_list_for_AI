# 01 Player Runner 설계

## 1. 제품 책임

Player Runner는 게임을 해석하거나 채점하는 프로그램이 아닙니다. 다음 네 가지를 책임집니다.

1. 승인된 로컬 게임 Canvas의 정확한 픽셀을 에이전트에게 제공
2. 정책에 허용된 키 또는 일회성 객체 행동만 실제 게임에 전달
3. 관찰·입력·결과 프레임을 변조 탐지 가능한 기록으로 남김
4. Wiki용 공개 handoff와 Judge용 비공개 envelope를 별도로 봉인

게임 엔진 source, DOM, accessibility tree, localStorage, network, seed, canonical truth는 에이전트에게 노출하지 않습니다. 전용 빈 브라우저 프로필과 localhost allowlist만 사용합니다.

## 2. 권한 모델

AI는 URL, 창 handle, selector, 좌표, 파일 경로를 도구 인자로 제출할 수 없습니다. 사람이 승인한 launch ticket으로 Runner가 대상 창과 Canvas를 미리 고정합니다.

실행마다 다음 capability를 발급합니다.

- `observeCap`: 최신 servedFrame 관찰
- `keyboardCap`: 허용 키 입력
- `objectCap`: 현재 프레임의 opaque option 활성화
- `bookmarkCap`: 공개 observation 후보 표시
- `handoffCap`: 실행 종료와 봉인 요청

capability는 run, 브라우저 context, 클라이언트, action budget, 만료시간에 묶입니다. 실제 token은 로그에 쓰지 않고 private fingerprint도 공개 handoff에 넣지 않습니다.

## 3. 로컬 도구 API

```ts
attach_run({ launchTicket }): {
  runId, observeCap, actionProfile, budgets
}

observe({ observeCap }): {
  frameId,
  image,
  actionState: 'READY'|'BUSY'|'PAUSED'|'ENDED',
  remainingBudget,
  options?: Array<{ optionRef: string }>
}

tap_key({ keyboardCap, requestId, expectedFrameId, code }): InputReceipt

activate_option({ objectCap, requestId, expectedFrameId, optionRef }): InputReceipt

wait_frame({ observeCap, afterFrameId, maxFrames }): {
  frameId, changeClass
}

bookmark_observation({ bookmarkCap, frameIds, precedingActionIds }): {
  observationId
}

request_end({ handoffCap, reason: 'COMPLETE'|'PARTIAL'|'ABORT' }): {
  state
}

seal_handoff({ handoffCap }): {
  publicArtifactDigest, privateEnvelopeDigest
}
```

AI가 `click(x, y)`, `press(rawString)`, `navigate(url)` 같은 호출을 할 수 있는 일반 도구는 제공하지 않습니다. `actionState`에는 고정 enum 외 detail/message/중첩 필드가 없고, object 트랙의 options에도 opaque optionRef 외 값을 넣지 않습니다.

현재 keyboard RPG 프로필의 허용 키는 게임 계약에 고정한 방향키, Enter, Tab, Space, Shift, B/C/F 등입니다. 키 조합, 붙여넣기, Escape, 임의 문자, JavaScript 실행은 프로필이 명시하지 않으면 거부합니다.

## 4. 좌표 추상화

직접 좌표 계산은 AI가 아니라 Runner 내부의 신뢰된 `Interaction Resolver`가 수행합니다.

```text
servedFrame + private interaction geometry
        │
        ▼
Interaction Resolver
  - 현재 프레임 후보 필터
  - 겹침/가시성/Canvas 경계 확인
  - 안전한 내부 점 계산
  - 일회성 optionRef 발급
        │
        ▼
AI: activate_option(optionRef)
        │
        ▼
Resolver: 최신 프레임 재검증 후 실제 좌표 클릭
```

optionRef는 `OPT-A7` 같은 무의미한 값이며 한 servedFrame과 한 번의 action에만 유효합니다. 화면이 바뀌면 모두 폐기됩니다. optionRef→polygon/좌표/DOM mapping은 메모리와 private transcript에만 존재합니다.

객체 후보의 geometry를 얻는 adapter는 의미 정보를 제거한 영역만 Runner에 제공합니다. game-specific adapter는 일반 Runner 개발자가 아니라 신뢰된 통합 담당자가 구현합니다. 순수 픽셀 운동 능력을 시험하려면 별도 raw-coordinate 트랙으로 분리하고 콘텐츠 이해 점수와 섞지 않습니다.

## 5. 프레임 파이프라인

1. 승인 origin, 전용 프로필, 1280×720 Canvas, zoom, crop fingerprint를 검증합니다.
2. Canvas 바깥 주소창·브라우저 UI가 한 픽셀도 들어가지 않게 캡처합니다.
3. object-action 트랙이면 고정 overlay 규격으로 opaque glyph만 합성합니다.
4. 에이전트에 보낸 정확한 바이트를 `servedFrame`으로 저장합니다.
5. campaign/run/frame, raw hash, overlay spec, option set, served hash, 이전 receipt를 private chain에 서명합니다.
6. 실제 MCP 응답마다 client binding과 response request digest가 포함된 `FrameServedEvent`를 서명합니다.

공식 Wiki evidence는 servedFrame입니다. raw Canvas는 공정성 감사에만 사용하고 Wiki나 에이전트에 제공하지 않습니다. keyboard 트랙은 overlay가 없으므로 raw와 served가 동일합니다. public frame은 유효한 serve event가 정확히 하나 있어야 하며 AI에게 전송되지 않은 capture는 seal에서 제외합니다.

ambient animation과 입력 이펙트를 구분하기 위해 입력 전 baseline, 입력 직후 echo frame, 안정화 frame을 비교합니다.

- `UNCHANGED`: 의미 있는 픽셀 변화 없음
- `TRANSIENT_ONLY`: 이펙트가 나타났다가 원상 복귀
- `PERSISTENT_CHANGE`: 안정화 뒤에도 변화 유지
- `UNCERTAIN`: 캡처 누락이나 애니메이션 때문에 판정 불가

Runner는 변화의 게임 의미를 해석하지 않습니다.

## 6. 입력 안전성과 exact-once

상태가 `READY`이고 expectedFrameId가 최신이며 capability가 유효할 때만 입력을 예약합니다. 하나의 mutation이 끝날 때까지 다음 mutation을 차단합니다.

```text
READY
 → ACTION_RESERVED
 → INPUT_DISPATCHING
 → WAITING_OUTCOME_FRAMES
 → READY
```

- 실제 OS 전달이 확인되면 `DELIVERED`입니다.
- 전달되지 않았음이 확인되면 `NOT_DELIVERED`입니다. 이 receipt는 최종이며 같은 행동을 원하면 새 requestId를 사용합니다.
- 전달 여부를 알 수 없으면 `DELIVERY_UNKNOWN`이며 자동 재시도하지 않습니다.
- keydown 뒤 keyup watchdog을 두어 stuck key를 방지합니다.
- 같은 행동을 변화 없이 세 번 반복하면 loop guard로 일시정지합니다.

crash-safe 순서는 `RESERVED request를 durable commit → OS dispatch → terminal receipt durable commit`입니다. 재시작 때 예약만 있고 terminal receipt가 없으면 `DELIVERY_UNKNOWN`으로 복원하며 재입력하지 않습니다. 같은 requestId+payload는 저장된 동일 receipt를 반환하고, 같은 requestId+다른 payload는 run을 INVALID로 봉인합니다. idempotency 기록은 run seal까지 보존합니다.

object action의 private receipt는 expected frame, optionSet digest, selected option digest, dispatch receipt digest를 frame receipt와 같은 서명 chain에 묶습니다. 공개 action에는 payload 없는 `opaqueActivate` 종류만 남습니다.

## 7. 실행 상태와 복구

정상 상태:

`CREATED → AWAITING_APPROVED_LAUNCH → CALIBRATING → READY ↔ OBSERVING/ACTION → ENDING → SEALING → SEALED`

중단 상태:

- `PAUSED_FOCUS`: focus 검증 실패
- `PAUSED_POLICY`: 사람 또는 loop guard 정지
- `RECOVERING_CAPTURE`: crop/frame pipeline 복구
- `RECOVERING_REPLAY`: 확인된 action prefix만 새 브라우저에 재생
- `BLOCKED`: 자동 복구 불가, partial seal 가능
- `INVALID`: 무결성 또는 경계 위반

브라우저 crash 복구는 private configHandle로 fresh instance를 열고 `DELIVERED`가 확정된 prefix만 재생합니다. 각 단계의 pHash와 engine receipt가 정책 범위에서 맞지 않으면 자동 복구를 중단합니다.

사람이 콘텐츠 판단에 개입하면 validity는 `ASSISTED`가 됩니다. focus 복원처럼 정책이 미리 정한 기계적 복구는 감사 로그를 남기고 official 유지 여부를 프로필 규칙으로 결정합니다.

## 8. 공개·비공개 출력

실행 중부터 두 저장소를 분리합니다.

```text
runs-public/<random-run-id>/     PublicPlayHandoff
judge-vault/<internal-run-id>/   PrivateJudgeEnvelope
```

공개 출력은 [Atlas Protocol](../packages/atlas_protocol/CONTRACT.md)의 allowlist만 새 객체로 생성합니다. private 객체에서 필드를 삭제해 공개 객체를 만드는 방식은 금지합니다.

strict 트랙은 hint, discovery note, label, hypothesis를 생성·전달하지 않으며 `frames/observations/actions` 외 Explorer 산출물을 폐기합니다. enum hint와 재조사는 별도 ASSISTED signed artifact에서만 허용하고 strict Knowledge, Document, Score의 parent가 될 수 없습니다.

private envelope에는 configHandle, gameBuildHandle, exact input transcript, idempotency chain, raw/served frame receipt가 들어갑니다. raw seed와 canonical truth는 Runner에도 주지 않습니다.

## 9. 감사 화면

사람용 로컬 대시보드는 다음을 보여줍니다.

- 에이전트가 받은 servedFrame
- focus/capture/input 상태와 frame age
- 남은 action/time budget
- 공개 action/observation timeline
- delivery 상태와 복구·개입 이력
- seal 전에 실제 공개될 파일과 hash

목표, 정답, hidden probe는 이 화면에도 기본 표시하지 않습니다. 사람의 개입 버튼과 에이전트 입력은 별도 감사 주체로 기록합니다.

## 10. 내부 모듈

```text
src/profile/          허용 입력·캡처 정책
src/capability/       범위 제한 token 발급·폐기
src/session/          run 상태 머신
src/browser/          전용 context와 focus
src/capture/          Canvas crop, servedFrame, change detector
src/interaction/      opaque option과 private 좌표 resolver
src/input/            exact-once keyboard/object gateway
src/audit/            append-only event chain
src/recovery/         crash/focus/capture 복구
src/handoff/          public/private 별도 sealer
src/mcp/              로컬 tool server
src/ui/               사람용 감사 대시보드
```

## 11. MVP 수용 기준

- raw 좌표, URL, selector 인자는 schema 단계에서 모두 거부됩니다.
- stale frame/만료 option/잘못된 capability 요청은 실제 입력 0회입니다.
- 같은 requestId를 100회 보내도 실제 입력은 최대 1회입니다.
- `DELIVERY_UNKNOWN` 뒤 자동 재입력이 0회입니다.
- dispatch 직후 crash fixture가 재시작 뒤 `DELIVERY_UNKNOWN`이 되며 입력을 반복하지 않습니다.
- 모든 agent image hash가 저장된 servedFrame hash와 같습니다.
- 모든 public frame이 정확히 하나의 signed FrameServedEvent와 연결됩니다.
- public archive에서 seed/config/fact/cue/target/coord/path/token fingerprint가 0건입니다.
- Wiki 계정이 judge-vault를 OS 권한으로 읽지 못합니다.
- keyboard 프로필에서는 raw와 served hash가 같습니다.
- object 프로필의 option mapping이 public artifact에 0건입니다.
- object action의 frame/option set/selected option/dispatch receipt private chain이 서로 일치합니다.
- 1-byte 변조된 frame/action/archive가 검증에서 실패합니다.
- focus loss, stuck key, browser crash, disk 부족 fault injection 중 무감사 입력이 0회입니다.
