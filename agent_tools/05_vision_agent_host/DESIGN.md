# 05 Vision Agent Host 설계

## v1 데이터 흐름

```text
Operator config
      | launch ticket / trusted process env
      v
AgentLoopSupervisor -----> PlayerRunnerStdioClient -----> 01 Player Runner
      |                          (8-method allowlist)          |
      | served PNG / receipt                                  v
      +<------------------------------------------------ Desktop Bridge
      |
      | PNG + minimal observation
      v
CodexHeadlessModelPort ---- codex exec / resume ----> GPT vision
      |                         ^
      |                         | root wrapper + nested exact anyOf schema
      v
provider wrapper -> compact ModelAction projection -> supervisor validation -> at most one Runner action

Optional ASSISTED player-context.json은 Supervisor에서 exact schema·8KB·금지 데이터 검증을 거친 뒤 비신뢰 JSON reference로만 prompt에 추가됩니다. 현재 픽셀 재확인, 맹목적 행동 재생 금지, 모순·신규 사례 북마크 규칙이 뒤따르며 원문은 driver journal에 기록되지 않습니다.

호스트는 context가 없으면 `EXPLORATION`, 있으면 `ASSISTED_EXPLORATION`을 trusted Runner 환경에 넣습니다. 일반 사용자 환경에서 같은 이름을 지정해도 전달하지 않으며, Runner가 해당 값을 receipt와 handoff에 서명하므로 후속 Wiki 단계가 원본 실행의 유형을 검증할 수 있습니다.
```

모델 포트와 Runner 클라이언트는 서로를 import하지 않습니다. supervisor만 두 포트를 의존성 주입으로 조립합니다.

## 실행 디렉터리

각 실행은 `agent_tools/.local/vision-agent/<hostRunId>/` 아래에 다음을 둡니다.

- `host/frames/F000001.png`: 모델에 실제 제공한 바이트
- `host/model/action.schema.json`: Supervisor 내부 행동 계약과 허용 키 snapshot
- `host/model/decision-1.json`: Codex turn별 root-wrapper 구조화 출력
- `host/driver.jsonl`: capability를 제거한 감독 이벤트
- `host/usage.json`: 검증된 turn별 토큰 합계, 완전성, 비용 미제공 상태
- `runner/`: Runner의 public/private artifact와 WAL

Codex 작업 디렉터리에는 위 모델 입력 파일만 보이도록 별도 하위 디렉터리를 사용합니다. 운영 단계에서는 이 디렉터리를 전용 OS identity/container에 mount하고 repo, `.git`, 다른 실행, private vault를 읽지 못하게 해야 합니다.

실제 진입점은 명시적인 `--confirm-openai-upload`를 요구합니다. 플래그 검증과 Codex 로그인 사전 확인은 Runner 시작과 첫 캡처보다 먼저 실행됩니다.

## Codex 대화

첫 판단은 `codex exec`, 후속 판단은 첫 JSONL의 `thread.started.thread_id`로 `codex exec resume <threadId>`를 사용합니다. 모든 호출은 현재 PNG를 `--image`로 첨부합니다. Model Port는 내부 행동 schema에서 허용 키를 엄격히 추출하고, root object의 `action` 아래에 행동별 exact object를 nested `anyOf`로 둔 OpenAI 호환 schema를 turn별로 exclusive-create해 `--output-schema`에만 전달한 뒤 프로세스 종료 시 제거합니다. 각 object는 선언한 모든 property를 required로 두고 `additionalProperties:false`를 사용합니다. 허용 키가 없으면 `press_key` branch를 제외하며, Provider에 보내지 않는 frame ID 중복 검사는 로컬 검증이 담당합니다.

직전 판단이 정확히 `MODEL_TURN_FAILED`이고 Codex 자식 프로세스의 `close`까지 확인된 idle 상태라면 Model Port는 인수 없는 `resetSession()`을 한 번만 허용합니다. 이 호출은 입력이나 모델 판단을 재시도하지 않고 기존 thread ID를 폐기하고 session generation을 증가시킵니다. 반환값은 `{ status: "RESET", nextInvocation: "EXEC", sessionGeneration }`의 고정된 비밀 비포함 receipt이며, 다음 판단은 fresh `codex exec`로 새 thread를 만들고 그 뒤부터 그 thread만 resume합니다. 성공, 다른 오류, reset 또는 비안전 reset 시도 뒤에는 자격이 사라집니다.

정상 판단이 성공해 thread가 확정되고 port가 idle인 직후에는 Supervisor가 인수 없는 `rotateSession()`으로 대화 context를 선제적으로 끊을 수 있습니다. 호출은 성공당 한 번만 허용되고 thread ID를 폐기하며 같은 generation을 증가시킨 뒤 `{ status: "ROTATED", nextInvocation: "EXEC", sessionGeneration }`만 반환합니다. 다음 판단은 fresh exec, 이후는 새 thread resume입니다. 실행 중·취소 중·직전 실패·thread 부재·인수 전달·중복 호출은 `MODEL_SESSION_ROTATION_UNSAFE`이며, 이 primitive 자체는 판단을 호출하지 않고 실패 후 reset 자격에도 관여하지 않습니다.

Supervisor 정책 프로필은 `DEFAULT`와 `ROLLOVER_ENDURANCE_2X` 두 값만 받습니다. 장기 프로필의 ceiling은 turn 120, key 60, observation 180, elapsed 2,700,000ms이고 나머지는 기존 기본값입니다. 명시 policy와 신뢰 Runner budget은 선택한 ceiling을 줄일 수만 있습니다. 이 프로필은 모델 prompt에 이름·55,000 token threshold·목표·완료/검증 수를 넣지 않으며, 모델의 정상 `finish` 선택을 막거나 더 오래 실행하도록 강제하지 않습니다.

성공한 rollover는 ordinal, 공용 session generation, 다음 turn, 동일 frame id/SHA-256에 묶인 pending validation을 만듭니다. 바로 다음 모델 호출, usage, action 검증 중 하나라도 실패하면 pending은 폐기합니다. action이 유효하면 기존 `frame_served -> model_turn_usage -> decision` 연속성을 먼저 유지하고 실제 finish/observe/bookmark/key side effect 전에 frame identity와 저장 바이트를 다시 확인합니다. 그 뒤 exact `model_rollover_validated { rolloverOrdinal, sessionGeneration, turn, frameId, frameSha256 }` 감사가 성공해야만 검증 수를 올립니다. 실패 시 Runner side effect 없이 격리합니다.

장기 프로필 결과만 `executionProfile`, `primaryScoreEligible:false`, `rolloverEndurance`를 추가합니다. 고정 55,000 input-token 기준을 충족한 rollover의 completed/validated 수가 각각 목표 2 이상일 때만 `requirementMet:true`, `status:"PASS"`이고, 아니면 정상 조기 종료를 포함해 `INSUFFICIENT_DURATION`입니다. 이 결과는 endurance 관측용이며 primary score 대상이 아닙니다. 기본 프로필 결과 shape는 변하지 않습니다.

JSONL `error`/`turn.failed`의 provider 진단은 원문을 저장하지 않습니다. 공식 `codexErrorInfo`의 알려진 string/tagged variant와 명시한 camel/snake alias만 category allowlist로 투영하고, tagged transport variant의 HTTP status도 100..599 정수 또는 `null`만 허용합니다. 결과는 `ModelPortError.codexErrorInfo`의 exact frozen `{ category, httpStatus, retryable }`이며 unknown·충돌·malformed는 `UNAVAILABLE/null/false`입니다. 원시 message, prompt, additional details, thread/turn ID, 경로, stderr는 오류·receipt·journal 경계로 전달하지 않으며 `retryable`은 관측 힌트일 뿐 자동 재시작 권한이 아닙니다.

Supervisor의 자동 재판단은 이 port primitive보다 더 좁습니다. 같은 verified frame 파일의 canonical regular-file·symlink 부재·SHA-256을 다시 검사하고, `DECIDING`, 정상 journal, pending mutation 없음, key count 불변, model idle, turn·elapsed 예산을 모두 만족할 때만 기본 1회(`modelRestarts: 0`이면 비활성) 허용합니다. 실패 turn과 새 판단 turn은 각각 usage turn을 소비하며 observation/key 예산은 소비하지 않습니다. `model_turn_failed` 뒤에 `model_restart_authorized`를 기록하고 exact reset receipt를 확인한 뒤 `model_session_reset`을 기록해야만 같은 frame으로 다음 모델 호출을 시작합니다. 어느 단계든 실패하면 추가 모델 호출 없이 격리합니다.

프로세스 exit code, JSONL 문법, 단일 thread id, 단일 최종 agent message, root wrapper와 nested action branch의 exact shape, compact projection, 금지 도구 이벤트 부재를 모두 확인한 경우에만 결정을 신뢰합니다. 구형 flat/null 출력이나 추가 필드는 drop 또는 normalize하지 않습니다. stderr와 원시 JSONL은 크기를 제한해 private 운영 로그로만 남기며 모델 응답을 그대로 Runner 오류에 포함하지 않습니다.

`turn.completed.usage`는 Model Port에서 세 숫자 필드만 allowlist 투영한 뒤 Supervisor가 turn delta로 합산합니다. 원시 이벤트, 계정, 로그인 방식, 모델 추정값, 가격표는 driver journal과 `usage.json`에 복사하지 않습니다. 모델 호출이 실패하거나 CLI가 usage를 생략하면 그 turn은 `missingTurns`로 남아 합계가 관측된 하한임을 표시합니다. 비용은 CLI가 실제 금액을 보고하지 않으므로 계산하지 않으며 토큰 집계 실패가 handoff 봉인 성공과 같은 축으로 표시되지 않게 합니다.

## 복구

모델 호출은 입력 mutation이 아니지만 자동 재판단 allowlist는 정확히 `MODEL_TURN_FAILED` 하나입니다. 위 Supervisor fence를 모두 만족할 때만 같은 frame을 fresh session에서 실행당 한 번 다시 판단하며, 다른 process/schema/tool/timeout 오류는 재호출하지 않습니다. Runner mutation은 어떤 timeout도 전달 여부가 불명확하므로 재시도하지 않고 실행을 격리합니다.

정상 종료는 `request_end`와 `seal_handoff` 두 단계입니다. 격리 종료에서도 가능한 경우 `PARTIAL`로 동일 단계를 수행하지만, 종료 실패를 숨기거나 입력을 더 보내지 않습니다.

## v1 제외 사항

- 시각 객체 검출과 opaque option 활성화
- 실시간 전투용 sub-second 제어
- Wiki 생성 자체는 별도 `06_assisted_wiki_loop` fresh process가 담당
- App Server 또는 custom/dynamic tools
- OS identity/container 자동 프로비저닝
- 사내 화면의 OpenAI 전송 승인 판단

## 남은 운영 위험

- 금지 tool event 검사는 해당 이벤트를 본 뒤 프로세스를 종료하는 사후 방어입니다. read-only sandbox만으로 다른 파일의 열람 가능성을 제거할 수 없으므로 사내 화면에서는 전용 VM 또는 별도 OS identity가 필요합니다.
- 같은 OS identity를 쓰는 다른 프로세스가 신뢰 디렉터리의 상위 경로나 frame 하위 디렉터리를 junction/symlink로 바꾸지 못하도록 운영 권한과 ACL을 분리해야 합니다.
- 자동 테스트는 fake Codex와 fake 화면을 사용합니다. 실제 Codex CLI 이벤트 종류·네트워크·OS 입력 호환성은 운영자 승인 아래 별도의 staging smoke test가 필요합니다.
- timed-out JSON-RPC의 늦은 응답은 transport를 닫아 fail-closed 처리합니다. 입력 재시도는 없지만, 이 경우 종료·봉인 artifact가 `PARTIAL`이거나 누락될 수 있습니다.
