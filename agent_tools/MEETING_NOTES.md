# 서브에이전트 설계 회의 기록

## 회의 방식

세 서브에이전트가 먼저 상대 모듈을 보지 않고 독립 설계를 작성했습니다.

- Player Runner 담당: 화면 캡처, 제한 입력, 좌표 추상화, 실패 복구
- Wiki Foundry 담당: evidence, entity/claim/procedure, 위키 정보 구조
- Replay Judge 담당: 실제 엔진 재생, 서명, anti-gaming, 블라인드 개발

그 뒤 각 담당자에게 다른 두 설계의 경계만 전달하고 적대적 교차검토를 요청했습니다. 1차 아이디어를 그대로 합치는 대신, 정보 누출이나 점수 gaming에 사용될 수 있는 필드를 삭제하거나 별도 트랙으로 분리했습니다.

초안 문서 작성 뒤 세 담당자가 다시 최종 감사를 수행했습니다. 이 3차 검토에서 crash 순간의 중복 입력, served frame이 실제 전송되었다는 증명, option glyph와 private 좌표의 서명 연결, replay artifact 바꿔치기, 개발 이후 production runtime 격리 문제를 찾아 계약에 반영했습니다.

## 주요 논점과 최종 결정

### 1. seed와 실행 식별자

초기안 일부에는 public seed, scenario key, layout key가 있었습니다. hash만 공개해도 조합 수가 작으면 dictionary attack으로 설정을 역산할 수 있다는 지적이 채택됐습니다.

결정:

- seed와 seed-derived hash/key를 공개 artifact에서 전부 제거
- Trusted Coordinator가 config 발급 전에 random run/artifact ID를 생성
- 여러 run 비교가 필요하면 Runner handoff 밖의 별도 signed EvidenceComparisonPlan이 낮은 엔트로피 group ordinal과 membership을 제공
- 실제 seed mapping은 Config Broker와 private registry만 보유

### 2. raw frame과 AI가 본 overlay frame

Player 설계는 raw Canvas를 Wiki 근거로 쓰자는 안, Judge 설계는 AI가 실제 본 frame만 공식 근거로 쓰자는 안으로 갈렸습니다.

결정:

- 인식 능력의 provenance를 우선해 AI가 받은 `servedFrame`만 public citeable evidence로 사용
- raw Canvas는 evaluator-only 공정성 감사에 보관
- keyboard 트랙은 두 frame이 동일
- object-action overlay는 의미 없는 고정 형식이며 target mapping은 private

### 3. Explorer 자유 메모

자유 메모는 탐사 결과 전달에 편리하지만 seed, 좌표, action script를 숨기는 대역폭이 됩니다.

결정:

- official strict 트랙에서 자유 메모 삭제
- scratch note는 Foundry 내부에서 export-inert
- 연구용 assisted 트랙만 제한된 enum/가설 구조를 허용하고 strict 점수와 분리

### 4. 위키 procedure와 action macro

source run의 키 순서가 문서에 들어가면 동일 조건 재현은 콘텐츠 이해가 아니라 macro 복사가 됩니다.

결정:

- procedure는 `travel-to/talk-to/acquire/craft/...` semantic DSL만 허용
- 좌표, N번째 메뉴, key sequence, timing, target token 금지
- 핵심 평가는 target/menu 순서를 바꾼 transfer run에서 수행

### 5. 재조사 루프

자유형 재조사 요청도 Wiki→Player의 숨은 채널이며 같은 Explorer를 재호출하면 대화 메모리가 남습니다.

결정:

- strict 트랙은 단방향
- assisted 트랙에서 enum 기반 contrast request만 Coordinator가 중계
- 매 요청은 fresh Inspector가 수행
- assisted 결과는 별도 보고

### 6. 블라인드 개발 환경

같은 repository에서 path만 나누거나 sparse checkout을 쓰는 방안은 `.git/objects`와 과거 commit을 통해 sibling 정보를 볼 수 있습니다.

결정:

- Contract Pack과 module stub을 `.git` 없는 별도 container/VM에 clean export
- read-only contracts와 단일 writable module만 mount
- network/clipboard/host browser profile 차단
- private CI와 통합은 별도 trusted 역할이 수행
- 현재 공유 filesystem 서브에이전트 회의는 설계 분업이며 실제 보안 격리는 아님을 명시

## 합의된 핵심 불변식

1. 비신뢰 에이전트는 seed, 정답, 점수, DOM, 좌표를 받지 않는다.
2. AI가 실제로 본 화면만 공식 시각 근거가 된다.
3. 행동 전달 여부가 불명확하면 반복하지 않는다.
4. Wiki의 모든 사실은 sealed frame까지 역추적된다.
5. 재현 문서는 구조화 graph에서 결정론적으로 생성한다.
6. 성공 판정은 실제 엔진의 fresh replay로만 한다.
7. 동일 조건 재현과 변경 조건 전이를 분리해 보고한다.
8. 자유형 cross-stage channel과 fact-level 평가 피드백을 차단한다.
9. 개발 Agent는 자신의 Contract Pack 밖 파일과 목적을 보지 못한다.
10. production truth, runtime, signing key를 한 역할에 모으지 않는다.

## 최종 감사에서 추가된 불변식

- input dispatch 전 durable reservation을 기록하며 terminal receipt 전에 죽으면 `DELIVERY_UNKNOWN`으로 복원한다.
- public frame마다 실제 AI 응답을 증명하는 signed FrameServedEvent가 정확히 하나 있다.
- object action은 frame, option set, selected option, dispatch receipt가 같은 private signature chain에 묶인다.
- strict handoff에는 hint와 comparison membership이 없고 보조 정보는 별도 signed artifact로만 존재한다.
- CohortPlan과 one-time ReplayAuthorization이 arm, target, document, probe, 반복 횟수를 함께 봉인한다.
- production Runner, Foundry, Judge, Registry, Engine, Key Service도 별도 OS identity/container로 실행한다.

## 구현 단계에서 확정할 운영 값

설계 경계는 합의했지만 다음 값은 게임 프로필별로 고정해야 합니다.

- capture FPS와 action 이후 안정화 frame 수
- key/action budget과 timeout
- object overlay의 정확한 색·폰트·크기
- Markdown page/전체 byte limit
- transfer config와 repetition 수
- 사람 개입을 OFFICIAL/ASSISTED로 분류하는 세부 규칙

이 값들은 전체 목적을 개발 Agent에게 공개하지 않고 Contract Manager가 versioned profile로 제공합니다.

## 후속 회의: 증거 승격과 범용 탐색

긴 campaign 결과에서 실제 근거가 없는 '항구 통행증', 표기가 충돌하는 '영약/영액'과 '푸른소금풀/푸른소금결정', 기존 상태·행동 반복이 확인되어 세 관점의 독립 검토를 진행했습니다.

- 지식 무결성 검토: 모델은 위키를 직접 쓰지 않고 evidence-bound atomic claim만 제안하며 entity registry와 결정론적 validator가 승격을 결정
- 탐색 정책 검토: NPC·지역·퀘스트가 아니라 visual state, affordance, allowed action, context, outcome 전이를 기준으로 Evidence-Grounded Frontier Exploration 채택
- 적대 평가 검토: hidden truth와 점수는 runtime에 전달하지 않고 unsupported entity, 반복률, 검증된 신규 전이, 모순 해결과 false-Wiki 철회를 평가

합의:

1. 현재 assisted Wiki는 정화 전까지 legacy/provisional로 취급한다.
2. 근거 없는 이름은 claim 단위로 격리하고 전체 Wiki build는 계속한다.
3. 같은 frame 재판독이나 이전 Wiki 인용은 독립 증거가 아니다.
4. 자연어 질문은 증거 요구량과 판정 조건이 있는 test card로 변환한 뒤에만 행동 목표가 된다.
5. 대상 이름이 아니라 동일 state/action/context/outcome의 증거 포화도를 기준으로 반복 우선순위를 낮춘다.
6. context가 달라지거나 claim이 약함·충돌·stale 상태이면 같은 대상도 재조사한다.
7. Player model은 후보만 제안하며 host가 gate, 중복 제거, 점수, 예산, loop recovery를 결정한다.
8. 구현은 Wiki 정화와 claim gate를 먼저 완료한 뒤 탐색 scheduler를 연결한다.
9. Quest Atlas 외 장르와 오염된 사전 Wiki를 포함한 holdout 시험을 통과해야 범용 정책으로 인정한다.

상세 단계와 수용 기준은 [다음 개발 계획](NEXT_DEVELOPMENT_PLAN.md)에 고정했습니다.
