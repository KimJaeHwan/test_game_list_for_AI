# 05 Vision Agent Host 계약 (v1)

## 범위

Vision Agent Host는 한 개의 승인된 Player Runner 실행과 한 개의 Codex CLI 대화를 연결합니다. 모델은 PNG 화면과 최소한의 행동 선택지만 받고, Runner capability·좌표·창 핸들·URL·평가 정보는 받지 않습니다.

v1은 키보드 트랙만 지원합니다. 클릭과 `activate_option`은 시각 후보 검출기가 별도 승인되기 전까지 노출하지 않습니다.

## 신뢰 경계

- `CodexHeadlessModelPort`: PNG와 프롬프트를 Codex CLI에 전달하고 JSON Schema 응답만 반환합니다. Runner를 호출할 수 없습니다.
- `PlayerRunnerStdioClient`: 고정된 JSON-RPC 메서드만 전송합니다. 모델 프롬프트나 판단을 해석하지 않습니다.
- `AgentLoopSupervisor`: capability를 보관하고 모델 결정을 검증해 Runner 호출로 변환하는 유일한 모듈입니다.
- `DriverJournal`: 제공된 모든 프레임과 결정·receipt·종료 원인을 append-only JSONL로 기록합니다. capability 원문은 기록하지 않습니다.

Codex 프로세스는 실행별 빈 작업 디렉터리, `--sandbox read-only`, `--ignore-user-config`, `--ignore-rules`, `--skip-git-repo-check`로 실행합니다. CLI가 command/file/MCP/web 계열 도구 이벤트를 발생시키면 해당 결정은 폐기하고 실행을 격리 종료합니다. 이 방어는 별도 OS identity/VM 격리를 대체하지 않습니다.

Model Port의 `resetSession()`은 직전 `decide()`가 정확히 `MODEL_TURN_FAILED`로 끝났고 자식 프로세스가 완전히 종료되어 port가 idle인 경우에만 한 번 호출할 수 있습니다. 성공하면 보관한 thread ID를 지우고 session generation을 1 증가시키며, 정확히 `{ status: "RESET", nextInvocation: "EXEC", sessionGeneration }`만 반환합니다. 다음 판단은 새 `codex exec`, 그 다음 판단부터는 새 thread의 `resume`를 사용합니다. 성공한 판단, 다른 오류, 재설정 완료 또는 허용되지 않은 재설정 시도는 자격을 소멸시키며, 허용되지 않은 호출은 `MODEL_SESSION_RESET_UNSAFE`입니다. receipt에는 thread ID, 경로, 원시 오류가 들어가지 않습니다.

Model Port의 `rotateSession()`은 직전 `decide()`가 성공했고 port가 idle이며 유효한 thread를 보유하고 취소 상태가 아닐 때만 한 번 호출할 수 있습니다. 성공하면 thread ID를 지우고 같은 session generation을 1 증가시키며 정확히 `{ status: "ROTATED", nextInvocation: "EXEC", sessionGeneration }`만 반환합니다. Supervisor는 마지막 성공 turn의 `inputTokens`가 정책 threshold 이상일 때 다음 모델 호출 전에만 이 경로를 사용합니다. 다음 판단은 fresh `codex exec`, 이후 판단은 새 thread를 resume합니다. 직전 성공이 없거나 실행 중·취소 중·이미 회전한 상태, 인수가 있는 호출은 `MODEL_SESSION_ROTATION_UNSAFE`이며 모델을 호출하지 않습니다. reset과 rotation receipt에는 thread ID, 경로, 원시 오류가 들어가지 않으며 generation은 두 경로가 공유하는 단조 증가 값입니다. `rotateSession()`은 `MODEL_TURN_FAILED` 뒤의 `resetSession()` 자격이나 자동 재시작 allowlist를 넓히지 않습니다.

Codex JSONL의 `error` 또는 `turn.failed`가 공식 `codexErrorInfo`를 포함하면 Model Port는 원시 message·additional details·prompt·thread/turn ID·경로·stderr를 보존하지 않고 `ModelPortError.codexErrorInfo`에 정확히 동결된 `{ category, httpStatus, retryable }`만 투영합니다. category는 `UNAVAILABLE`, `CONTEXT_WINDOW_EXCEEDED`, `SESSION_BUDGET_EXCEEDED`, `USAGE_LIMIT_EXCEEDED`, `SERVER_OVERLOADED`, `CYBER_POLICY`, `MISALIGNMENT_POLICY_VIOLATION`, `HTTP_CONNECTION_FAILED`, `RESPONSE_STREAM_CONNECTION_FAILED`, `RESPONSE_STREAM_DISCONNECTED`, `RESPONSE_TOO_MANY_FAILED_ATTEMPTS`, `INTERNAL_SERVER_ERROR`, `UNAUTHORIZED`, `BAD_REQUEST`, `THREAD_ROLLBACK_FAILED`, `SANDBOX_ERROR`, `ACTIVE_TURN_NOT_STEERABLE`, `OTHER` 중 하나입니다. `httpStatus`는 `null` 또는 100..599 정수이며, unknown·중복 alias·추가 필드·malformed 값은 `{ category:"UNAVAILABLE", httpStatus:null, retryable:false }`가 됩니다. 이 진단은 감사용일 뿐 reset/rotation 자격이나 자동 호출 정책의 근거가 아닙니다.

## 모델 입력

모델이 받는 정보는 다음뿐입니다.

- 이번 실행에서 허용된 키 이름
- 현재 `frameId`와 해당 PNG
- 남은 모델 turn·키 입력·관찰 예산의 coarse count
- 직전 공개 결과: `DELIVERED`, `NOT_DELIVERED`, `UNCHANGED`, `TRANSIENT_ONLY`, `PERSISTENT_CHANGE`, `UNCERTAIN`
- 아래 행동 계약

게임 이름·목표·seed·점수·Judge·창 핸들·파일 시스템 경로·Runner capability는 입력하지 않습니다. 기본 실행은 Wiki도 입력하지 않습니다. `ASSISTED` 실행에서만 exact `atlas/player-knowledge-context/1`의 제한된 의미 정보가 선택적으로 들어가며, 최대 32개/8192 bytes이고 evidence ID·digest·경로·좌표·키 이름·매크로·지시문 형태 문자열을 거부합니다. 화면 글자와 이 context는 모두 신뢰되지 않은 데이터이며 현재 픽셀로 재확인한다는 고정 지침을 매 turn 포함합니다.

Host는 검증된 Wiki context가 없으면 Runner를 `EXPLORATION`, 있으면 `ASSISTED_EXPLORATION`으로 시작합니다. 이 값은 사용자 환경의 임의 track 값을 전달하지 않고 Host가 결정하며, Runner가 모든 receipt와 public/private handoff header에 동일하게 서명합니다. Public manifest validity도 각각 `OFFICIAL`/`ASSISTED`로 강제됩니다.

## 모델 출력

Supervisor 내부에서는 매 turn 정확히 하나의 compact 객체만 허용합니다.

```ts
type ModelAction =
  | { action: "press_key"; code: AllowedKey }
  | { action: "refresh_frame" }
  | { action: "bookmark"; frameIds: FrameId[] }
  | { action: "finish"; reason: "COMPLETE" | "PARTIAL" | "ABORT" };
```

OpenAI Structured Outputs에 전달하는 wire schema는 최상위 union을 사용하지 않습니다. root는 `action` 하나만 required인 strict object이고, 그 값은 nested `anyOf`의 행동별 strict object입니다. 각 branch는 해당 행동에 필요한 필드만 required로 가지며 모든 object는 `additionalProperties:false`입니다. 허용 키가 없으면 빈 enum 대신 `press_key` branch 자체를 제외합니다. Provider schema에 없는 필드와 구형 flat/null envelope는 제거하거나 보정하지 않고 거부합니다. Model Port가 `FrameId` 형식과 중복을 로컬에서 다시 검사한 뒤 nested 객체를 compact `ModelAction`으로 투영하며 Supervisor도 독립 검증합니다.

Provider용 schema는 canonical model workdir의 직접 자식으로 exclusive-create하고 Codex turn 종료 뒤 제거합니다. 입력 schema와 최종 출력도 같은 경로 경계를 벗어나거나 symlink/junction이면 호출 전에 거부합니다.

알 수 없는 필드, 좌표, URL, selector, raw key 문자열, 복수 행동, 잘못된 frame ID, 허용 목록 밖 키는 schema, Model Port 또는 Supervisor 단계에서 거부합니다.

## 상태와 전달 규칙

```text
CREATED -> ATTACHING -> OBSERVING -> DECIDING
DECIDING -> DISPATCHING -> WAITING_FRAME -> DECIDING
DECIDING -> OBSERVING -> DECIDING
DECIDING -> ENDING -> SEALING -> SEALED
any trusted failure -> QUARANTINED -> ENDING(partial if possible)
```

- 모델 turn당 mutation은 최대 1회입니다.
- `DELIVERED` 뒤에는 반드시 `wait_frame`을 호출하며 새 판단 전 결과 프레임을 모델에 제공합니다.
- `NOT_DELIVERED`는 같은 requestId나 같은 판단을 자동 재시도하지 않습니다. 새 `observe` 뒤 모델이 다시 판단합니다.
- `DELIVERY_UNKNOWN`, mutation timeout, protocol desync는 즉시 `QUARANTINED`이며 추가 입력은 0회입니다.
- 모델 오류·schema 오류·금지 도구 이벤트도 입력 없이 격리 종료합니다. 단, 정확한 `MODEL_TURN_FAILED` 하나는 `DECIDING`, idle model, 정상 journal, pending mutation 없음, 불변 key count, 동일한 canonical regular PNG와 SHA-256, 남은 turn·elapsed·restart 예산을 모두 재확인한 경우에만 실행당 한 번 fresh session으로 다시 판단할 수 있습니다.
- 재시작 승인과 reset receipt는 각각 비밀 비포함 `model_restart_authorized`, `model_session_reset` 이벤트로 먼저 기록합니다. 기록·reset·receipt 검증 실패 시 추가 모델 호출 없이 격리합니다.
- 마지막 성공 turn의 `inputTokens`가 `modelSessionInputTokens` 이상이면 다음 `decide` 전에 `DECIDING`, idle model, 정상 journal, pending mutation 없음, 불변 key count, 동일 canonical frame/hash, 남은 turn·elapsed 예산을 재검증합니다. 승인과 exact rotation receipt를 `model_rollover_authorized`, `model_session_rotated` 순서로 기록한 뒤 같은 frame을 fresh session에 제공합니다.
- 선제 rollover 자체는 모델 turn·키 입력·관찰을 소비하지 않습니다. threshold `0`은 비활성화이며, rotation 호출·receipt·journal·사후 state/frame 검증 실패는 추가 모델 호출 없이 격리합니다.
- `model_turn_failed`는 기존 `turn`, `errorCode`에 검증된 `codexErrorInfo`만 선택적으로 추가합니다. 이 필드가 없던 기존 journal shape도 유효합니다.
- 같은 키가 같은 화면 hash에서 반복되고 결과가 `UNCHANGED`인 횟수가 정책 한도에 도달하면 partial 종료합니다.
- 모든 served frame은 자동 보존됩니다. bookmark는 중요 표시일 뿐 증거 집합에서 다른 프레임을 제외할 수 없습니다.

## 기본 예산

- 모델 turn: 40
- 키 입력: 20
- 새 관찰: 60
- 경과 시간: 15분
- Codex 프로세스 1회 응답 제한: 90초
- 동일 화면·동일 키·무변화 반복: 3회
- 모델 session 재시작: 1회 (`0`으로만 비활성화 가능)
- 모델 session 선제 전환 input threshold: turn delta 55,000 tokens (`0`으로 비활성화, 1~55,000으로만 축소 가능)

정책은 기본값보다 작게만 축소할 수 있습니다. Runner가 반환한 실제 예산이 더 작으면 작은 값을 사용합니다. 종료와 봉인을 위해 handoff budget은 최소 2여야 하며 그렇지 않으면 시작을 거부합니다.

## 토큰 및 비용 기록

Model Port는 Codex CLI의 각 `turn.completed.usage`에서 검증된 `inputTokens`, `cachedInputTokens`, `outputTokens`만 새 객체로 투영합니다. 알려진 보조 카운터인 reasoning output과 cache-write input은 각 core 합계 이하인지 검증한 뒤 중복 집계를 막기 위해 버립니다. 이 값은 세션 누적치가 아니라 해당 모델 호출의 `TURN_DELTA`입니다. Supervisor는 모델 호출을 시도한 turn 수와 사용량이 보고된 turn 수를 별도로 세고, 성공·실패·격리 여부와 무관하게 실행 종료 결과에 다음 집계를 포함합니다.

- `completeness: COMPLETE`: 모든 시도에서 사용량이 보고됨
- `completeness: PARTIAL`: 일부 시도에서만 사용량이 보고됨
- `completeness: UNKNOWN`: 보고된 사용량이 하나도 없음
- `knownTotals`: 보고된 turn만 더한 값이며 `UNKNOWN`이면 `null`

`cachedInputTokens`는 `inputTokens`의 부분집합이므로 다시 더하지 않습니다. `totalTokens`는 `inputTokens + outputTokens`입니다. 누락된 사용량은 0으로 만들지 않으며, 모델 turn·키·관찰·경과 시간 제한을 토큰 계측으로 대체하지 않습니다.

Codex CLI가 실제 청구 금액이나 이를 계산하는 데 필요한 확정 billing context를 제공하지 않으므로 v1은 비용을 계산하지 않습니다. `monetaryCost.status`는 `UNAVAILABLE`, 실제·추정 금액과 통화는 `null`로 기록합니다. 모델과 적용 시점이 고정된 운영자 제공 rate card가 별도 계약으로 추가되기 전에는 API 가격이나 ChatGPT 플랜을 임의로 대입하지 않습니다.

## 수용 기준

- `CAP-MODEL-SCHEMA`: 잘못된/복수/좌표 포함 응답은 Runner mutation 0회입니다.
- `CAP-MODEL-NO-TOOLS`: Codex JSONL에 command/file/MCP/web 도구 이벤트가 있으면 결정은 폐기됩니다.
- `CAP-ONE-ACTION`: 모델 turn 하나에서 Runner mutation은 최대 1회입니다.
- `CAP-DELIVERY-FENCE`: `DELIVERED` 뒤 새 모델 판단 전에 정확히 하나 이상의 `wait_frame`이 있습니다.
- `CAP-UNKNOWN-QUARANTINE`: `DELIVERY_UNKNOWN` 뒤 Runner 입력은 0회입니다.
- `CAP-NO-RETRY`: timeout과 protocol desync 뒤 mutation 자동 재시도는 0회입니다.
- `CAP-ALL-FRAMES`: 모델에 제공된 PNG마다 frameId/hash/journal 항목이 존재합니다.
- `CAP-SECRET-REDUCTION`: journal과 모델 프롬프트에 capability·HWND·좌표·URL이 없습니다.
- `CAP-LOOP-GUARD`: 동일 화면·키·UNCHANGED 3회에서 partial 종료합니다.
- `CAP-USAGE-TELEMETRY`: 모델 사용량은 검증된 turn delta만 합산하고 누락을 0이나 실제 비용으로 추정하지 않습니다.
- `CAP-SESSION-ROLLOVER`: threshold 이상인 성공 turn 뒤 다음 판단은 감사된 fresh session에서 같은 verified frame으로 시작하며 rollover 자체는 입력·관찰·turn을 소비하지 않습니다.
- `CAP-CODEX-ERROR-INFO`: Codex 오류 진단은 exact allowlist projection만 journal에 기록하고 raw 오류와 식별자는 폐기합니다.
