# 03 Replay Judge 설계

## 1. 제품 책임

Replay Judge는 에이전트가 작성한 “성공했다”는 말을 평가하지 않습니다. 봉인된 행동을 fresh game state에서 실제로 재생하고, 비공개 engine probe로 콘텐츠 재현을 판정합니다.

책임:

1. artifact schema, 서명, parent digest, nonce 검증
2. Registry Service에 opaque capability 검증 요청
3. pinned engine build에 signed transcript 재생 요청
4. 동일 조건 재현과 변경 조건 전이 관계 검증
5. Truth/Scoring Service의 signed response와 실제 outcome 점수 합성
6. 공개 aggregate 보고서와 evaluator-only 감사 보고서 생성

Replay Judge는 하나의 논리 제품이지만 Judge Coordinator, Registry, Engine Runner, Truth/Scoring, Key Service는 별도 identity/process입니다. Judge Coordinator는 raw seed/truth/production key를 보지 않고 signed response만 조합합니다. Engine Runner는 registry mapping과 truth weight를 보지 않으며, Truth Service는 모델 runtime/action transcript를 직접 실행할 수 없습니다. Judge는 Player/Wiki UI를 구현하지 않고 agent가 제출한 success, stateHash, actionCount, reference route를 신뢰하지 않습니다.

## 2. Private Registry와 Engine Replay

Registry Service만 다음 mapping을 보유합니다. Judge는 목적 제한 capability로 lookup 결과를 요청할 뿐 raw mapping을 열람하지 않습니다.

```text
random runId
  → sourceConfigHandle
  → targetConfigHandle[]
  → canonicalTruthHandle
  → probeSetHandle
  → gameBuildHandle
```

```ts
interface EngineReplayPort {
  replay(input: {
    authorization: ReplayAuthorization;
    signedActions: SignedActionTranscript;
  }): Promise<SignedEngineOutcome>;
}
```

Engine Runner는 authorization에서 검증된 one-time target capability, pinned build, probe만 해석하고 독립적인 config/build/probe 선택 인자를 받지 않습니다. 매 요청을 fresh process와 fresh state에서 실행합니다. 같은 transcript를 두 번 재생해 nonce/signature를 제외한 전체 outcome payload와 probe vector가 다르면 `INVALID_ENGINE_RUN`입니다.

## 3. Cohort Plan과 실행 권한

실험 전에 Coordinator가 `SignedCohortPlan`으로 source, arm, 전체 target, build, probe, agent/prompt/budget profile, repetition, 무작위 순서 commitment를 봉인합니다.

각 run에는 정확히 하나의 `ReplayAuthorization`을 발급합니다. 이 권한은 cohort plan, reproduction/transfer track, baseline/candidate/oracle arm, source handoff, knowledge/document digest, target run/config, repetition, nonce를 함께 서명하며 한 번만 소비됩니다.

ActionTranscript는 authorization과 정확한 normalized document digest를 부모로 삼습니다. EngineOutcome은 authorization과 transcript를 부모로 삼습니다. ScoreReport는 signed plan의 target×arm×repetition 완전한 집합을 재계산하고, 누락·추가·중복·다른 document나 target의 결과를 hard fail합니다.

## 4. 서명 체인

JSON은 RFC 8785 JCS로 canonicalize하고 SHA-256 digest와 Ed25519 서명을 사용합니다.

```text
Runner: PublicPlayHandoff + PrivateJudgeEnvelope
                   │
Coordinator: KnowledgeReceipt
                   │
Judge: NormalizedDocument binding
                   │
Input Gateway: ActionTranscript
                   │
Engine Runner: EngineOutcome
                   │
Judge: ScoreReport
```

모든 envelope는 artifact type/version, random ID, issuer, key ID, nonce, parent digest, payload digest, contract digest를 가집니다.

hard fail:

- 1-bit mutation 또는 서명 실패
- nonce 재사용
- 다른 run/track/document의 artifact 재사용
- parent digest 누락·교체
- 만료된 capability
- agent가 만든 가짜 EngineOutcome

production private key는 전용 Key Service에만 있습니다. Key Service는 artifact별 issuer policy와 parent 관계를 통과한 digest만 서명하며 payload, truth, runtime을 보지 않습니다. 개발자에게는 public test key와 고정 test vector만 줍니다.

Judge는 public frame마다 같은 run의 `SignedFrameServedEvent`가 정확히 하나인지 확인하고, private raw bytes와 overlay primitive manifest를 pinned compositor로 재합성합니다. 재합성 served bytes와 public hash가 다르거나 optionSet/action receipt chain이 끊기면 hard fail입니다. ActionTranscript는 ReplayAuthorization에 속한 gap-free `SignedInputReceipt` chain만 수락합니다.

## 5. 지식 평가

기존 03 게임의 private 평가 로직을 adapter로 재사용할 수 있습니다.

- `canonicalFactsFromWorld(world)`: canonical truth
- `evaluationContextFromState(state)`: 실제 화면에 노출된 evidence와 fact
- `validateKnowledgeSubmission()`: knowledge schema gate
- `evaluateSubmission()`: fact/evidence/hallucination/실행 합성
- `runVerifiedReplay()`: 단일 process test adapter
- `exportScoreMarkdown()`: 최종 report

기존 `discoverableFactIds`는 의미상 `exposedFactIds`로 취급해야 합니다. 이론상 도달 가능한 `reachableFactIds`는 private oracle/probe가 별도 계산합니다.

WeakSet 기반 attestation은 같은 JS process 안에서만 유효합니다. Judge가 별도 service가 되면 직렬화된 WeakSet 결과가 아니라 `SignedEngineOutcome`으로 교체합니다.

## 6. 재현과 전이

### 동일 조건 재현

탐사 종료 뒤 Player와 Wiki 프로세스·브라우저·메모리를 폐기합니다. 새로운 Reproduction Agent에 정규화 Wiki와 fresh Canvas만 줍니다. private registry 기준 scenario/layout/visual/session config가 source와 완전히 같은 run에서 실제 완료율을 측정합니다.

이 지표는 procedure가 같은 조건에서 재현되는지를 보여주지만, source action 암기의 영향이 있을 수 있으므로 핵심 점수로 단독 사용하지 않습니다.

### 변경 조건 전이

semantic rule graph는 같고 layout/visual/session과 target/menu order 중 하나 이상을 바꿉니다. source seed/hash/좌표/action log를 주지 않습니다. 최소 2개의 private transfer config에서 문서 의미를 이용해 완료할 수 있는지 평가합니다.

### 대조군

동일한 모델, prompt, budget, target config를 사용합니다.

- `baseline`: 문서 없음
- `candidate`: AI가 만든 정규화 Wiki
- `oracle`: 신뢰된 canonical Wiki

절대 completion을 먼저 보고하고, 문서 효용은 다음 보조값으로 둡니다.

```text
utility = clip((candidate - baseline) / (oracle - baseline), 0, 1)
```

baseline/oracle 결과를 candidate 절대 점수에 섞지 않습니다. 순서를 blind randomize하고 최소 2 transfer config × 2 repetition을 권장합니다.

## 7. ProbeSet

ProbeSet은 실험 시작 전에 Coordinator가 서명합니다. goal ID 집합, weight, denominator를 고정하며 agent가 고를 수 없습니다.

- 빠진 goal은 0점
- 같은 쉬운 goal을 중복 제출해도 1회만 인정
- 추가 goal은 denominator를 바꾸지 않음
- 모든 판정은 agent text가 아니라 engine state에서 수행
- probe별 상세 feedback은 평가 캠페인 종료 전 공개하지 않음

Foundry가 rule claim에 사용한 comparison membership도 signed EvidenceComparisonPlan과 다시 대조합니다. unknown ref, duplicate run, cross-group run, ASSISTED/INVALID run이 포함되면 그 claim을 거부합니다.

## 8. Anti-gaming 위협과 대응

| 공격 | 대응 |
|---|---|
| 성공 자기 신고·state hash 위조 | actual engine replay와 engine signature |
| action count/reference 조작 | input gateway 계수와 signed oracle artifact |
| 다른 run outcome 복제 | run/track/config/document/probe digest binding |
| 모든 OBS를 한 claim에 몰기 | citation 수 제한, 같은 claim 지지 여부 검증 |
| 쉬운 probe만 제출 | signed fixed ProbeSet exact equality |
| seed hash 사전 역산 | high-entropy private seed, random opaque handle, public hash 금지 |
| bundle/source map에서 truth 읽기 | server-side content, no source map, canary scan |
| Wiki 숨은 명령 | structured graph, AST allowlist, deterministic renderer |
| key macro를 공략으로 저장 | semantic procedure DSL, target/menu order randomization |
| prompt injection 게임 대사 | 화면 text를 untrusted evidence로 경계, 외부 tool 차단 |
| unknown 남발 | unknown 보상 없음, 실제 exposed fact recall 유지 |
| 유리한 nondeterministic replay 선택 | 같은 transcript를 fresh process에서 2회 재생 |
| 반복 평가로 holdout 학습 | seed/probe rotation, aggregate 지연 공개 |

## 9. Canary와 누출 격리

private fixture마다 독립 128-bit canary를 삽입합니다.

- `GT_CANARY`: hidden fact metadata
- `CUE_CANARY`: evidence cue mapping
- `SEED_CANARY`: registry/config
- `PROBE_CANARY`: hidden goal
- `SIBLING_CANARY`: 다른 모듈 Contract Pack

검사 위치는 model prompt와 tool I/O, servedFrame OCR, DOM/accessibility dump, browser JS/CSS/WASM/source map/network, PublicPlayHandoff, Knowledge, normalized Wiki, ActionTranscript, public report, CI failure log입니다.

scanner는 raw/case-fold, NFC/NFKC, control 제거, URL/base64/base32/hex decode, reverse/chunk 형태를 검사합니다. 한 개라도 발견하면 점수를 내지 않고 `LEAKAGE_QUARANTINED`로 격리합니다.

## 10. 문서 정규화 검증

Foundry가 만든 raw Markdown을 그대로 Reproduction Agent에 주지 않습니다.

1. Knowledge JSON schema와 provenance를 검증합니다.
2. safe semantic procedure DSL을 검증합니다.
3. 허용된 AST로 다시 materialize합니다.
4. Unicode/공백/줄바꿈을 canonicalize합니다.
5. HTML, comment, image, URL, code, invisible 문자, token을 검사합니다.
6. normalized file hash map과 KnowledgeReceipt를 binding합니다.

사람용 자유 서술 Wiki와 scored structured Wiki를 분리합니다. 둘의 결과를 같은 점수로 합치지 않습니다.

## 11. 공개·비공개 보고서

공개 보고서:

- 유효/무효/격리 상태
- cohort별 aggregate completion
- baseline/candidate/oracle 비교
- reproduction과 transfer 분리
- evidence precision/recall과 hallucination aggregate
- confidence interval

비공개 감사 보고서:

- config/probe capability
- engine replay hashes
- fact/cue 수준 차이
- leakage hit 위치
- invalid artifact 상세

공개 보고서에는 seed, config/content hash, fact/cue/probe ID, 개별 holdout 정답, oracle route를 넣지 않습니다.

## 12. 내부 모듈

```text
src/contracts/          signed envelope와 schema
src/attestation/        JCS, digest, Ed25519, nonce
src/registry/           opaque handle lookup
src/replay-port/        Engine Runner adapter
src/probe-set/          goal set 고정·검증
src/cohorts/            reproduction/transfer/control
src/scoring-adapter/    기존 03 평가기 연결
src/leakage/            canary와 covert channel scan
src/reports/            public/private report
```

## 13. MVP 수용 기준

- artifact 1-bit mutation, wrong parent/run/track/doc, nonce 재사용을 100% 거부합니다.
- self-reported 또는 JSON clone EngineOutcome의 실행 점수는 0입니다.
- accepted outcome은 actual engine replay 2회에서 같은 final hash를 냅니다.
- accepted outcome은 두 replay의 전체 probe vector와 outcome payload도 같습니다.
- reproduction은 private registry에서 exact source config만 허용합니다.
- transfer는 same rule graph와 changed non-scenario config를 모두 만족합니다.
- signed ProbeSet의 누락·중복 goal이 0건입니다.
- no-doc/candidate/oracle가 같은 모델·prompt·budget·target set을 사용합니다.
- ScoreReport가 signed cohort plan의 target×arm×repetition 완전한 집합만 포함합니다.
- strict와 assisted/reinspection 결과를 합치지 않습니다.
- agent-visible 경로의 private canary hit가 0건입니다.
- canary hit 시 report 대신 `LEAKAGE_QUARANTINED`가 생성됩니다.
- raw→served transform과 public evidence hash의 서명 chain이 일치합니다.
- public frame과 FrameServedEvent가 1:1이며 미제공 capture가 public evidence에 없습니다.
- signed input receipt chain이 gap-free이고 request/payload/run binding이 일치합니다.
- comparison claim의 run membership이 signed EvidenceComparisonPlan과 일치합니다.
