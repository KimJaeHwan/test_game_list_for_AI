# 블라인드 모듈 개발 운영

## 1. 목적

개발 에이전트가 평가의 전체 목적, 실제 콘텐츠, 정답, seed, 점수 가중치를 알고 있으면 테스트를 통과하도록 구현을 맞추는 specification gaming이 생길 수 있습니다. 이를 줄이기 위해 각 에이전트는 자신이 구현할 모듈의 계약과 합성 fixture만 받습니다.

프롬프트로 “다른 파일을 보지 말라”고 하는 것만으로는 격리가 아닙니다. 같은 repository와 `.git/objects`를 읽을 수 있다면 다른 모듈과 과거 commit을 볼 수 있습니다.

## 2. 실제 격리 방식

권장 개발 환경:

1. Trusted Coordinator가 계약 패키지와 대상 모듈 stub만 clean export합니다.
2. `.git`이 없는 별도 container 또는 VM에 넣습니다.
3. `/contracts`는 read-only, `/work/module`만 writable로 mount합니다.
4. repo root, sibling module, host filesystem, clipboard, browser profile을 mount하지 않습니다.
5. network는 기본 차단하고 꼭 필요한 registry만 hash-pinned proxy로 허용합니다.
6. secret이 없는 process/env를 제공하고 crash dump/core dump를 비활성화합니다.
7. 완료 시 patch, public test 결과, input/output tree digest만 회수합니다.
8. private 통합 테스트는 별도의 trusted CI에서 실행합니다.

sparse checkout이나 worktree만으로는 보안 경계가 아닙니다. OS ACL로 repo와 `.git` 접근을 실제 차단할 수 있을 때만 보조 수단으로 사용합니다.

개발 격리는 실행 격리를 대체하지 않습니다. Runner, Foundry, Judge, Registry, Engine Runner, Key Service는 `.git` 없는 별도 OS identity/container에서 실행합니다. 각 process는 allowlist read-only input, 단일 writable volume, capability-only IPC만 받고 host/sibling/env secret/clipboard/network 접근은 OS에서 거부합니다.

반입 patch는 Coordinator가 경로를 다시 검증합니다. symlink, hardlink, junction, NTFS ADS, submodule, binary/install hook, path traversal을 거부하고 clean reproducible build와 tree digest를 새로 계산합니다.

현재 Codex 서브에이전트는 동일 filesystem을 공유하므로 이번 회의는 설계 역할 분리이지 실제 블라인드 개발이 아닙니다. 구현 단계부터 위 격리 환경을 사용해야 “gaming 방지”라고 주장할 수 있습니다.

## 3. Contract Pack 공통 구성

각 모듈 Pack에는 다음만 포함합니다.

- 역할을 설명하는 1페이지 charter
- 소유 path와 수정 가능 범위
- semver가 고정된 TypeScript/JSON Schema/OpenAPI
- MUST/SHALL 상태 머신과 sequence
- coarse error code 표
- 크기, 시간, rate, budget, idempotency limit
- JCS/Ed25519 public test key와 고정 signature vector
- deterministic clock/RNG mock
- `Room A`, `Token B` 같은 synthetic fixture
- capability acceptance ID와 실행 명령
- 금지 import/path/field 목록
- `PUBLIC/AGENT_VISIBLE/EVALUATOR_ONLY/SECRET` 분류

실제 게임명, quest/recipe, holdout seed, canonical truth, 다른 에이전트 prompt와 root README는 Pack에 넣지 않습니다.

## 4. 모듈별 배정

### Desktop Bridge 세분화

Desktop Bridge는 단일 Agent에게 화면 획득과 대상 선택, 입력 정책을 모두 주지 않습니다.

- Native Bridge Agent: Win32 창 열거, 합성 픽셀 캡처, OS 입력 primitive만 구현
- Target Broker Agent: injected identity의 pin/revalidation과 opaque ticket만 구현
- Safe Input Agent: 고정 action schema와 delivery 분류만 구현
- Integration Coordinator: 공개 계약으로 세 결과를 Player Runner adapter에 연결

세 Agent 모두 게임 규칙, Wiki/Judge 구조, 점수식, 실제 holdout, 애플리케이션별 URL/API를 받지 않습니다. 이번 구현 배정과 테스트 결과는 [Desktop Bridge 구현 배정 기록](04_desktop_bridge/AGENT_ASSIGNMENTS.md)에 남깁니다.

### Runner 개발 Agent

받는 것:

- CanvasFrame, AllowedAction, InputRequest/Receipt 계약
- capture와 overlay 고정 규격
- 상태 머신, exact-once, focus/drop/crash synthetic fixture
- public/private sealer의 schema와 redaction invariant

받지 않는 것:

- 게임 목표·규칙·콘텐츠 문자열
- seed 생성과 canonical fact/cue
- Wiki schema 내부와 Judge 점수식
- game-specific target의 의미 mapping

게임 adapter와 target resolver의 geometry provider는 신뢰된 통합 담당자가 별도 구현합니다.

### Wiki 개발 Agent

받는 것:

- immutable PublicPlayHandoff schema
- 공개 ontology와 canonicalization 규칙
- Evidence→Claim→Procedure 승격 정책
- deterministic Markdown AST/renderer 규칙
- 악성 공개 fixture와 validation error code

받지 않는 것:

- 게임 URL/engine/source와 실제 콘텐츠 catalog
- seed, truth graph, hidden goal
- Runner target map/좌표/private transcript
- Judge score weight와 재현 agent prompt

### Judge 개발 Agent

받는 것:

- signed envelope, registry capability, ProbeSet, EngineReplayPort
- cohort/scoring 계약과 synthetic truth
- forged outcome, missing probe, nondeterminism fixture

받지 않는 것:

- live seed map과 production truth 이름
- Runner/Wiki UI source
- production signing key

### Private Fixture Custodian

실제 GeneratedWorld, canonical truth, cue mapping, seed registry, holdout을 관리합니다. 일반 앱 source 대신 최소 adapter만 접근하며 모델 runtime과 action transcript에는 접근하지 않습니다.

### Integration Coordinator

전체 interface와 모든 patch를 볼 수 있지만 live holdout seed와 signing key는 볼 수 없습니다. schema version, capability test, artifact digest만으로 통합합니다.

### Engine Runner와 Key Service

Engine Runner는 one-time ReplayAuthorization, pinned build, probe 실행물만 받고 registry mapping과 truth weight를 보지 않습니다. Key Service는 artifact별 issuer policy와 parent 관계를 검증한 digest만 서명하며 payload, truth, runtime을 보지 않습니다.

### Adversarial Reviewer

전체 위협 모델과 built artifact를 보아 공격을 설계할 수 있지만 production seed map과 signing key는 받지 않습니다. 구현 Agent와 동일 인물·동일 대화 메모를 쓰지 않습니다.

## 5. 역할별 지식 매트릭스

| 역할 | 전체 흐름 | 다른 앱 source | 실제 truth/content | raw seed map | 점수식 | live key |
|---|---:|---:|---:|---:|---:|---:|
| Runner Agent | 아니오 | 없음 | 없음 | 없음 | 없음 | 없음 |
| Wiki Agent | 아니오 | 없음 | 없음 | 없음 | 없음 | 없음 |
| Judge Agent | 평가 단계만 | 없음 | synthetic만 | 없음 | 필요 배점만 | 없음 |
| Contract 관리자 | 경계만 | interface만 | 없음 | 없음 | 계약 수준 | test key만 |
| Integration Coordinator | 예 | read-only | adapter schema만 | opaque handle만 | 예 | 없음 |
| Private Fixture Custodian | 예 | 최소 adapter | 예 | 예 | expected 결과 | 없음 |
| Engine Runner | 실행 권한만 | binary/API | probe 실행물만 | one-time capability | 없음 | 없음 |
| Key Service | 서명 목적만 | 없음 | 없음 | 없음 | 없음 | 예 |
| Adversarial Reviewer | 위협 전체 | built artifact | 격리 sample | 없음 | 예 | 없음 |
| Experiment Operator | 실행 절차 | binary/API | 없음 | capability만 | aggregate만 | 없음 |

raw seed/truth, 모델 runtime/action transcript, production signing authority 중 어떤 두 권한도 같은 사람, service account, container에 함께 주지 않습니다. 모든 교차 요청은 목적 제한 one-time capability와 2인 승인 로그를 요구합니다.

## 6. 개발 생명주기

```text
Contract Manager
  → Contract Pack과 synthetic fixture 봉인
  → 격리된 Module Agent 구현
  → public conformance test
  → patch와 tree digest 회수
  → Adversarial Reviewer 정적/동적 공격
  → trusted CI private fixture
  → Integration Coordinator 계약 수준 통합
  → holdout 실행
```

private CI 실패는 `CAP-EVIDENCE-RUN-BOUNDARY` 같은 capability code와 opaque fixture ID만 돌려줍니다. expected fact, seed, cue, probe를 오류 메시지로 출력하지 않습니다. 반복 실패가 있어도 secret fixture를 개발 Agent에게 공개하지 않고 Custodian이 원인을 분류합니다.

## 7. Agent 작업 지시 템플릿

각 개발 Agent의 prompt는 아래 형식으로 제한합니다.

```text
역할: <module>의 <submodule> 구현자
소유 경로: <한 경로>
입력 계약: <version/digest>
출력 계약: <version/digest>
허용 의존성: <목록>
금지 접근: sibling, repo root, .git, network, secret 등급
필수 상태/오류: <목록>
수용 테스트: <capability ID 목록>
완료 산출물: patch, public test report, tree digest
```

“AI 평가를 잘 통과시키기”, “이 게임의 정답을 찾아라” 같은 전체 목적 문구는 넣지 않습니다. 구현자는 주어진 input을 계약대로 변환하고 failure mode를 처리하는 데만 집중합니다.

## 8. Submodule 세분화

한 Agent가 전체 모듈의 생산자와 검증자를 모두 구현하지 않도록 더 나눕니다.

- Runner: capture / capability / input gateway / recovery / sealer
- Foundry: import / evidence / entity+claim / procedure lint / renderer
- Judge: attestation / registry / replay port / probe / scoring / leakage

검증기와 생산기를 다른 Agent가 구현하고 Adversarial Reviewer가 별도 검토합니다. 예를 들어 Runner sealer 개발자는 public leakage scanner를 구현하지 않고, Foundry renderer 개발자는 Judge의 Markdown sanitizer를 구현하지 않습니다.

## 9. Private CI 필수 공격 fixture

- config-derived deterministic ID 사전 공격
- key 이름 변경·중첩·문자열 값으로 private data 삽입
- source map/minified bundle의 canary 탐색
- 모든 OBS 몰아넣기, 무관 OBS 혼합, cross-run OBS 재사용
- duplicate nonce, seq reorder, receipt payload 교체
- HTML comment, zero-width, base64, key macro Wiki
- self-reported/wrong-track/wrong-document outcome
- missing hard probe, duplicate easy probe
- agent-selected target config
- 동일 transcript의 이중 재생 불일치
- baseline/candidate/oracle target set 불일치

## 10. 운영 수용 기준

- Module Agent container에서 sibling/root/`.git`/network/clipboard 접근이 모두 거부됩니다.
- production module끼리도 sibling volume/env/host filesystem에 접근할 수 없습니다.
- 반입 patch의 symlink/junction/ADS/submodule/install hook/path traversal 검사가 모두 통과합니다.
- Contract Pack digest와 구현 input tree digest가 기록됩니다.
- public fixture에는 실제 콘텐츠와 private canary가 0건입니다.
- private test 실패 로그에는 expected truth가 0건입니다.
- 생산기와 검증기, fixture와 signing key 책임자가 분리됩니다.
- raw truth, 모델 runtime, signing authority 중 두 권한이 같은 identity에 배정되지 않습니다.
- 통합 담당자가 live seed와 production key 없이 전체 pipeline을 조립할 수 있습니다.
- 같은 Agent의 대화 메모가 Player→Wiki→Reproduction 단계 사이에 재사용되지 않습니다.
