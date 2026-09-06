# Agent Tools 다음 개발 계획

상태: PLANNED

범위: 증거 기반 지식 무결성 및 장르 비종속 탐색

구현 상태: 시작 전

## 1. 목표와 비목표

다음 개발 단계는 장시간 화면 기반 플레이에서 얻은 지식을 증거와 함께 누적하고, 그 지식을 이용해 이미 검증한 행동의 불필요한 반복을 줄이면서 새로운 콘텐츠를 탐색하게 만드는 것이다.

핵심 정책은 NPC·퀘스트·지역·아이템 같은 특정 장르 개념, DOM/CDP, 게임 엔진 API, 정답 카탈로그에 의존하지 않는다. '항구 통행증'처럼 화면 근거가 없는 모델 생성 명칭은 정식 엔티티나 다음 플레이의 지침이 될 수 없어야 한다.

비목표:

- Player/Wiki Agent에 source, seed, truth, 평가 점수, DOM, 좌표 또는 엔진 상태 제공
- Quest Atlas의 이름·진행 규칙·키 매핑을 범용 정책에 하드코딩
- 페이지 수, 질문 수, 문장 길이, 턴 수, 토큰 사용량 또는 게임 점수 최적화
- 한 번의 실패나 미관찰을 전체 부재로 일반화
- LLM이 생성한 서술형 Markdown을 권위 있는 지식 원장으로 사용

## 2. 채택 결정

서로 독립적으로 시험 가능한 두 기능을 순서대로 도입한다.

1. Evidence-gated knowledge publication
2. Evidence-Grounded Frontier Exploration(EGFE)

~~~text
bounded frames + input/effect receipts
                 |
                 v
       immutable evidence ledger
                 |
                 v
       atomic claim proposal (LLM)
                 |
                 v
 entity binding + deterministic validation
          |                        |
          v                        v
 verified knowledge views     investigation queue
          |                        |
          +-----------+------------+
                      v
          generic exploration scheduler
                      |
                      v
                 visual player

hidden truth/evaluator is read-only and never feeds the loop
~~~

## 3. 범용 지식 모델

코어 온톨로지는 visual_state, affordance, allowed_action, transition, context_signature, evidence_ref에 한정한다. NPC·퀘스트·지역·보스·아이템 등은 선택적인 학습 태그일 뿐 scheduler와 승격 규칙의 필수 필드가 아니다.

### 3.1 지식 종류

- OBSERVATION: 화면에서 직접 보인 것. 인과 해석 없음
- ACTION_ATTEMPT: 승인된 입력이 전달됐다는 사실. 성공을 의미하지 않음
- ACTION_OUTCOME: 유효 receipt와 시간적으로 결합된 전후 화면 변화
- SOURCE_CLAIM: NPC·문서·튜토리얼이 무엇이라고 말했다는 사실
- INFERENCE: 증거로부터 도출한 해석
- HYPOTHESIS: 앞으로 검증할 후보

게임 속 발언은 “그 발언을 관찰했다”는 것만 증명한다. 발언 내용의 세계적 진실은 별도로 검증해야 한다.

### 3.2 Claim 상태

~~~text
UNGROUNDED -> GROUNDED -> SUPPORTED -> VERIFIED
                   |          |           |
                   +----------+-----------+
                              v
              CONFLICTED / STALE / RETRACTED
~~~

- 모델 confidence는 증거가 아니다.
- 같은 frame을 여러 번 또는 여러 모델이 읽어도 증거는 한 건이다.
- 이전 Wiki 문장을 모델이 반복한 것은 새 증거가 아니다.
- 독립 증거는 별도 관찰 시점, 다른 UI 표면, 또는 의미 있게 다른 문맥에서 재현한 결과여야 한다.
- claim ID, scope, evidence lineage, conflict와 supersession은 압축·샤딩 뒤에도 유지한다.

## 4. 허위 엔티티 차단

### 4.1 엔티티 등록부와 승격

- LLM은 자유 서술로 canonical entity를 만들 수 없다.
- provisional entity는 화면의 observed span 또는 visual anchor와 evidence_ref에서 시작한다.
- 이후 claim의 subject/object는 registry ID에 binding한다.
- binding되지 않은 명칭은 해당 claim만 UNBOUND_ENTITY로 격리하고 Wiki build 전체는 계속한다.
- OCR·철자 유사 후보는 자동 병합하지 않고 alias conflict로 유지한다.
- 이름 1회 관찰은 OBSERVED_LABEL이며 아이템·기능의 존재 확정이 아니다.
- canonical entity는 독립 관찰 2회 또는 '획득 표시 → 지속 목록 재확인' 같은 강한 cross-surface 증거가 필요하다.
- 절차 성공 1회는 observed case, 독립 성공 2회는 SUPPORTED, 다른 문맥 재현과 실패 경계 확인 뒤 VERIFIED로 승격한다.
- 잠금·인과 조건은 성공/실패 대조쌍 또는 명시적 안내와 실제 재현이 필요하다.
- 소문은 반복돼도 SOURCE_CLAIM이며 직접 행동 결과가 명제를 별도로 지지해야 한다.

### 4.2 게시 뷰

- canonical fact와 fast-path player guidance: VERIFIED
- 범위가 명시된 관찰·사례: SUPPORTED
- 소문·보고: 화자가 명시된 SOURCE_CLAIM
- 조사 대기열: HYPOTHESIS, UNGROUNDED, CONFLICTED
- 감사 기록: RETRACTED, SUPERSEDED, 거부된 unbound claim

Markdown과 player-context는 claim store에서 결정론적으로 생성한다.

### 4.3 현재 Wiki 정화

다음 assisted exploration 전에:

- 기존 entity와 claim의 evidence lineage를 재검사한다.
- 근거가 없는 '항구 통행증'은 RETRACTED_SYNTHETIC으로 기록한다.
- retracted/unbound claim을 player-context에서 제거하되 감사 기록은 삭제하지 않는다.
- '약초 영약/영액', '푸른소금풀/푸른소금결정' 등은 증거가 해결할 때까지 alias/transcription conflict로 유지한다.
- 모든 제거·병합·상태 변경을 correction revision으로 게시한다.

## 5. Evidence-Grounded Frontier Exploration

### 5.1 범용 목표와 test card

- DISCOVER: 시도하지 않은 안전한 affordance 또는 state/action frontier
- VERIFY: 근거가 약하지만 grounded된 claim 재확인
- RESOLVE: 충돌하는 claim·관찰 판별
- BOUNDARY: 잠금·실패·조건부 전이 경계 시험
- REPRODUCE: 알려진 절차를 통제된 조건에서 재현
- RECOVER: 비생산 루프를 벗어나 마지막 안정 상태로 복구

이름이 같은 대상을 방문했다는 이유로 낮추지 않는다. 같은 state/action/context 결과가 충분히 검증됐을 때만 우선순위를 낮춘다.

자연어 질문은 claim_under_test, alternative_outcomes, grounding_status, visual_anchor, prerequisites, candidate_action_templates, evidence_required, 판정 관찰, attempts, cooldown, staleness scope를 가진 test_card로 컴파일한다.

- ungrounded proper noun은 플레이 목표가 될 수 없다.
- 성공은 예상 답을 맞히는 것이 아니라 대안을 구분할 증거를 얻는 것이다.
- 실행 가능한 관찰·행동이 없는 질문은 backlog에 남긴다.
- 문장이 아니라 claim과 evidence requirement 기준으로 중복을 병합한다.

### 5.2 Host-side 점수

~~~text
priority = gate * (
  expected_information_gain
  + frontier_value
  + uncertainty_or_conflict_value
  + breadth_of_questions_affected
  + reachability
  + action_diversity
  + underexplored_family_bonus
  - expected_action_token_time_cost
  - recent_repeat_loop_penalty
  - safety_risk
)
~~~

Player model은 후보만 제안하며 gate, 중복 제거, 점수 계산은 host가 수행한다. 근거 없는 목표, 전제 미충족, 중복 card, 금지 행동, target-window 불확실, 외부 효과 가능성은 gate=0이다.

초기 예산 가이드이며 게임 규칙으로 하드코딩하지 않는다: frontier 60%, 약한 claim·모순 검증 20%, verified 재감사 10%, 복구·봉인 10%. 남는 예산은 frontier로 반환하고 전체 예산의 마지막 15%는 봉인·checkpoint·안전 종료에 예약한다.

### 5.3 반복·막힘·fast path

- micro-goal은 3~8 actions 또는 남은 segment 예산의 10% 중 작은 값으로 제한한다.
- 동일 state/action/context는 최대 2회이며 두 번째는 결과가 불명확하거나 조건을 바꾼 경우만 허용한다.
- 3회 연속 새 화면 변화·증거가 없거나 2~4 state loop가 두 번 반복되면 STUCK/recovery를 시작한다.
- recovery는 다중 frame 재관찰, 허용된 neutral/back/cancel 1회, 검증 경로 복귀, 목표 cooldown, 안전 후보가 없으면 checkpoint·종료 순이다.
- model-call failure 때는 입력을 보내지 않는다. retry/recovery는 gameplay attempt가 아니다.

Known fast path는 context signature 일치, action/outcome 재현, 관련 open/conflict/stale 없음, 전제의 화면 확인, 중요 전이 재관찰을 모두 만족해야 한다. 동적 콘텐츠를 놓치지 않도록 verified 지식도 설정 가능한 5~10% 재감사를 남긴다.

## 6. Checkpoint·압축·검색

모델 내부 자동 압축을 기다리지 않고 usable context의 70~80%, micro-goal 완료, 새 evidence 수, STUCK/recovery, 시간·segment budget 중 하나에서 host checkpoint를 만든다.

Checkpoint에는 sealed evidence/receipt, claim delta와 판정, test-card 상태, state-transition coverage, 상위 후보와 do-not-repeat signature, failure/cooldown/남은 예산/마지막 안정 상태를 저장한다.

다음 모델에는 관련 verified shard, 실행 가능한 상위 test card, 반복 억제 정보와 recovery state만 전달한다. prose 재요약으로 claim을 만들지 않는다. 한 호출의 screenshot 선택 수는 working-set 한도일 뿐 전체 증거 한도가 아니며 validator가 claim별 최소 evidence bundle을 다시 로드한다.

## 7. 정보 경계와 gaming 방지

- Player: bounded frame/history/action, 관련 verified guidance, 선택된 test card
- Claim proposer: sealed evidence와 이전 claim 상태, hidden truth 없음
- Validator: claim과 직접 증거만 사용하며 player narration은 증거가 아님
- Scheduler: test card, evidence saturation, coverage, risk, cost만 사용
- Evaluator: hidden truth를 읽지만 runtime으로 피드백하지 않음

새로움은 host가 evidence-backed state/action/outcome signature로 계산한다. 모델 선언, 이름만 바꾼 중복, 긴 문서, 질문 추가는 점수가 없다.

## 8. 개발 단계와 종료 조건

### P0 — Freeze, audit, schema contract

- 기존 assisted Wiki를 player retrieval에서 legacy/provisional 처리
- evidence/entity/claim/scope/conflict/test-card/transition schema와 상태·거부 코드 정의
- 현재 unsupported/conflicting claim correction report 생성

종료: unsupported name의 canonical/player-context 진입 0, 모든 게시 claim의 evidence lineage 해석 가능.

### P1 — Claim validator and deterministic publisher

- entity binding과 claim-level validation
- proposer 출력과 canonical storage 분리
- Markdown, machine context, investigation, audit view 생성
- revision/shard 사이 claim identity와 evidence 보존

종료: unbound claim만 격리, 같은 frame 반복 승격 불가, 지식 종류별 분리 게시, 철회의 의존 claim/player-context 전파.

### P2 — State/transition index and test-card compiler

- 범용 visual-state clustering과 context signature
- grounded gap, conflict, untried affordance에서 test card 생성
- 중복 병합과 attempt/cooldown/prerequisite/outcome 추적

종료: core scheduler의 RPG 필수 개념 0, ungrounded 질문 action dispatch 0, 문맥 변화 시 실험 eligibility 복원.

### P3 — EGFE scheduler and long-run integration

- host-side gate/score/budget/loop detection/recovery
- checkpoint 기반 knowledge update와 targeted retrieval
- recoverable failure 뒤 uncertain action 중복 없이 재개

종료: known stable transition 반복 감소, conflict/new evidence targeted revisit, rollover 뒤 queue/cooldown/do-not-repeat 보존.

### P4 — Generalization and adversarial evaluation

- 동일 seed/budget의 assisted/unassisted A/B
- entity rename, layout, key map, locale/font, dynamic response, misleading text, incorrect pre-seeded Wiki 시험
- RPG 외 puzzle/strategy 또는 real-time testbed와 비공개 holdout 장르 평가
- evaluator truth의 runtime 미유입 증명

종료: canonical unsupported-entity rate 0, false claim 증가 없이 verified knowledge/action 개선, false Wiki 격리·철회, core 정책의 Quest Atlas 식별자·규칙 0.

## 9. 평가·모듈 배정·필수 시험

주요 지표는 canonical precision/unsupported-entity rate, 100 actions당 verified novel transition, reproducible procedure, test-card 해결률, 모순 해결률, verified-state 반복률, action/token/time당 지식 증가, checkpoint 간 중복, false knowledge correction, assisted/unassisted 효율이다. 문서량·질문 수·턴 수·게임 점수는 진단용이다.

구현 모듈은 evidence/entity/claim validator, deterministic publisher/retrieval, visual state/transition index, test-card compiler, EGFE scheduler/recovery, hidden evaluator/generalization suite로 분리한다. 각 에이전트에는 interface contract, fixture, acceptance test와 안전 제약만 주고 hidden truth와 전체 scoring function은 제공하지 않는다.

필수 fixture:

- frame 근거 없는 fabricated name
- OCR/name variant의 premature merge
- 같은 frame 재해석
- 소문과 action outcome 충돌
- 한 번의 실패를 global absence로 오판
- 같은 visual target의 다른 context와 dynamic stale 지식
- 2-state/4-state input loop
- action 전 model failure, proposal 뒤 failure, Wiki build failure
- pending claim delta가 있는 rollover
- incorrect pre-seeded Wiki correction
- UI skin/layout/key-map/language 및 non-RPG transfer

각 단계는 player path가 source/evaluator data를 읽지 않고 acceptance test를 통과해야 완료된다.
