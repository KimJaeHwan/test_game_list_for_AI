# Atlas Protocol v1

## 1. 목적

Atlas Protocol은 Player Runner, Wiki Foundry, Replay Judge 사이에서 전달되는 데이터의 최소 계약입니다. 모듈은 상대 구현을 import하지 않고 이 계약 패키지만 의존합니다.

핵심 불변식:

1. agent-visible artifact에는 seed, seed 파생 hash, canonical truth ID가 없다.
2. 공식 시각 증거는 AI에게 실제로 제공된 `servedFrame` 바이트다.
3. 입력은 한 번만 전달되며 전달 여부가 불명확하면 자동 반복하지 않는다.
4. 모든 공개 스키마는 allowlist이며 `additionalProperties: false`를 강제한다.
5. 제출된 성공 여부와 상태 hash를 믿지 않고 실제 엔진 재생으로 판정한다.
6. 각 artifact는 부모 digest와 서명으로 실행·문서·결과를 연결한다.

## 2. 데이터 등급

| 등급 | 예시 | 접근 주체 |
|---|---|---|
| `PUBLIC` | 스키마, ontology, 오류 코드 | 모든 모듈 |
| `AGENT_VISIBLE` | servedFrame, OBS, 정규화 Wiki | 해당 단계 에이전트 |
| `EVALUATOR_ONLY` | signed transcript, configHandle, probe 결과 | Judge 계층 |
| `SECRET` | raw seed, canonical truth, live signing key | 전용 custodian/service |

`SECRET`는 Runner·Foundry·개발 에이전트의 환경변수, 로그, fixture, 오류 메시지에 존재해서는 안 됩니다.

## 3. 식별자와 문자열 규칙

- `runId`와 `artifactId`는 Trusted Coordinator가 configHandle을 발급하기 전에 최소 128-bit CSPRNG로 생성하고 발급 attestation을 남깁니다. Runner와 Agent는 값을 고르거나 다시 발급할 수 없습니다.
- UUIDv7처럼 생성 시각을 드러내는 ID보다 UUIDv4 또는 128-bit base64url을 사용합니다.
- `frameId`, `actionId`, `observationId`는 각각 `F000001`, `A000001`, `O000001` 문법의 run-local ordinal입니다.
- `mediaRef`와 `files.relativeName`은 `frames/F000001.png`, `observations.ndjson`, `actions.ndjson`처럼 계약이 열거한 경로만 허용합니다. 자유 파일명은 금지합니다.
- policy version은 미리 서명된 CampaignProfile allowlist의 정확한 값만 허용합니다. Runner가 임의 문자열을 넣을 수 없습니다.
- artifact 자체의 무결성 digest 외에 scenario/layout/config/content digest를 agent-visible 데이터에 넣지 않습니다.

여러 handoff의 비교군은 Runner manifest에 넣지 않습니다. Trusted Coordinator가 handoff 봉인 뒤 다음 별도 계획을 발급합니다.

```ts
interface EvidenceComparisonPlanV1 {
  schemaVersion: 'atlas/evidence-comparison-plan/1';
  planId: string;
  groups: Array<{
    groupRef: string; // G01, G02 ...
    handoffDigests: string[];
  }>;
  signature: string;
}
```

`groupRef`는 plan 내부의 낮은 엔트로피 ordinal이며 equality 비교 외에 사용할 수 없습니다. Foundry는 signed membership을 수정할 수 없고 groupRef를 agent-authored field, entity ID, 정렬 재료, 파일명, Wiki 본문, 재현용 Knowledge output에 넣지 않습니다. Judge 전용 provenance attachment만 원 plan의 groupRef를 보존하며 Judge는 서로 다른 OFFICIAL run인지 다시 확인합니다.

## 4. PublicPlayHandoff

Wiki Foundry가 받는 유일한 Runner 산출물입니다.

```ts
interface PublicPlayHandoffV1 {
  manifest: {
    schemaVersion: 'atlas/public-play-handoff/1';
    artifactId: string;
    runId: string;
    status: 'COMPLETE' | 'PARTIAL' | 'INVALID';
    validity: 'OFFICIAL' | 'ASSISTED' | 'INVALID';
    framePolicyVersion: string;
    inputPolicyVersion: string;
    capture: { width: number; height: number; format: 'png'; colorSpace: 'srgb' };
    counts: { frames: number; observations: number; actions: number; interventions: number };
    files: Array<{
      role: 'frames' | 'observations' | 'actions';
      relativeName: string;
      bytes: number;
      sha256: string;
    }>;
    payloadDigest: string;
  };
  frames: PublicFrame[];
  observations: PublicObservation[];
  actions: PublicAction[];
}

interface PublicFrame {
  frameId: string;
  ordinal: number;
  mediaRef: string;
  sha256: string;
  evidenceRole: 'CITEABLE';
  sourceActionRefs: string[];
}

interface PublicObservation {
  observationId: string;
  ordinal: number;
  frameRefs: string[];
  precedingActionRefs: string[];
}

interface PublicAction {
  actionId: string;
  ordinal: number;
  input:
    | { kind: 'keyTap'; code: AllowedKey }
    | { kind: 'opaqueActivate' };
  delivery: 'DELIVERED' | 'NOT_DELIVERED' | 'DELIVERY_UNKNOWN';
  beforeFrameRef: string;
  afterFrameRefs: string[];
  changeClass: 'UNCHANGED' | 'TRANSIENT_ONLY' | 'PERSISTENT_CHANGE' | 'UNCERTAIN';
}
```

의도적으로 없는 필드는 timestamp, URL, 절대 경로, DOM/selector, 좌표, bounding box, target/option ref, capability, seed/config, 내부 entity/fact/cue/probe ID, hidden state, OCR, Runner의 자연어 해석입니다.

`PublicPlayHandoff`에는 hint, label, hypothesis, comparison membership도 없습니다. 이 세 배열과 고정 manifest 외의 필드는 모두 거부합니다.

PNG에는 EXIF, 임의 text chunk, 콘텐츠별 ICC metadata를 넣지 않습니다. 프레임은 canonical encoding 규격을 통과해야 합니다.

## 5. Served Frame 계약

`servedFrame`은 에이전트에게 전송된 정확한 이미지 바이트입니다.

- keyboard 트랙: raw Canvas와 servedFrame이 byte-identical합니다.
- object-action 트랙: 신뢰된 Resolver가 고정 사양의 opaque glyph overlay를 합성한 결과가 servedFrame입니다.
- public evidence는 servedFrame만 포함하고 raw Canvas는 evaluator-only 감사 저장소에 둡니다.
- overlay는 의미, 타입, 우선순위, 성공 가능성, 목표 진행률을 표현하지 않습니다.
- option과 실제 좌표의 mapping은 공개 artifact에 포함되지 않습니다.
- Wiki는 화면의 glyph나 일회성 option token을 콘텐츠 사실로 인용할 수 없습니다.

private frame receipt는 raw/overlay/served 관계뿐 아니라 campaign, run, frame, option set, 이전 receipt를 함께 서명합니다. 이를 통해 다른 실행의 frame 바꿔치기와 사후 option mapping 변경을 탐지합니다.

정확한 private 계약은 다음과 같습니다.

```ts
interface PrivateFrameReceipt {
  campaignId: string;
  internalRunId: string;
  publicRunId: string;
  frameId: string;
  frameOrdinal: number;
  gameBuildHandle: string;
  capturePolicyDigest: string;
  rawHash: string;
  overlayPolicyDigest: string;
  overlayCompositorVersion: string;
  overlayPrimitivesDigest: string;
  optionSetDigest?: string;
  servedHash: string;
  previousFrameReceiptDigest?: string;
  signature: string;
}

interface SignedFrameServedEvent {
  internalRunId: string;
  publicRunId: string;
  clientBindingDigest: string;
  frameId: string;
  servedHash: string;
  frameOrdinal: number;
  responseRequestDigest: string;
  frameReceiptDigest: string;
  signature: string;
}
```

Judge는 private raw bytes와 overlay primitive manifest를 pinned compositor로 다시 합성해 served bytes와 public frame hash를 byte-for-byte 비교합니다. keyboard 트랙은 raw/served bytes의 직접 동일성을 확인합니다. 모든 public frame은 정확히 하나의 유효한 serve event와 연결되어야 하며, 캡처했지만 AI에게 제공하지 않은 frame은 public seal에 들어갈 수 없습니다.

## 6. 입력 receipt

모든 mutation은 다음 요청 키로 exact-once 처리합니다.

```ts
interface InputRequest {
  runId: string;
  requestId: string;
  expectedFrameId: string;
  capability: string;
  action:
    | { kind: 'keyTap'; code: AllowedKey }
    | { kind: 'activate'; optionRef: string };
}

interface InputReceipt {
  requestId: string;
  status: 'DELIVERED' | 'NOT_DELIVERED' | 'DELIVERY_UNKNOWN';
  actionOrdinal?: number;
  retry: 'NEW_REQUEST_REQUIRED' | 'DO_NOT_RETRY' | 'NOT_APPLICABLE';
  receiptDigest: string;
}
```

- 같은 `requestId`와 같은 payload의 중복 요청은 같은 receipt를 반환합니다.
- 같은 `requestId`에 다른 payload를 보내면 hard fail입니다.
- `NOT_DELIVERED`는 실제 입력이 없다는 최종 receipt이며, 같은 행동을 다시 원하면 새 requestId가 필요합니다.
- `DELIVERY_UNKNOWN`이면 자동 재전송하지 않습니다.
- 한 mutation의 delivery가 확정되기 전에는 다음 mutation을 받지 않습니다.
- optionRef는 특정 servedFrame과 한 번의 action에만 유효하며 화면 변화 시 만료됩니다.

Input Gateway는 dispatch 전에 `RESERVED(canonicalRequestDigest)`를 durable commit한 뒤 OS 입력을 수행합니다. terminal receipt도 durable commit합니다. 재기동 시 RESERVED만 있고 terminal receipt가 없으면 `DELIVERY_UNKNOWN/DO_NOT_RETRY`로 복원하며 자동 입력하지 않습니다. idempotency store는 적어도 run seal 완료까지 보존합니다.

```ts
interface SignedInputReceipt {
  campaignId: string;
  internalRunId: string;
  publicRunId: string;
  requestId: string;
  canonicalRequestDigest: string;
  expectedFrameId: string;
  optionSetDigest?: string;
  selectedOptionDigest?: string;
  dispatchReceiptDigest?: string;
  status: 'DELIVERED' | 'NOT_DELIVERED' | 'DELIVERY_UNKNOWN';
  actionOrdinal?: number;
  retry: 'NEW_REQUEST_REQUIRED' | 'DO_NOT_RETRY' | 'NOT_APPLICABLE';
  beforeFrameReceiptDigest: string;
  afterFrameReceiptDigests: string[];
  previousInputReceiptDigest?: string;
  signature: string;
}
```

opaque action은 expected frame, 당시 option set, 선택 option, 실제 dispatch receipt를 같은 서명 chain에 묶습니다. 이 digest들은 evaluator-only이며 공개 action에는 `opaqueActivate` 종류만 남습니다.

## 7. PrivateJudgeEnvelope

Runner가 Judge에만 보내는 별도 저장소의 산출물입니다.

```ts
interface PrivateJudgeEnvelopeV1 {
  schemaVersion: 'atlas/private-judge-envelope/1';
  internalRunId: string;
  publicHandoffDigest: string;
  configHandle: string;
  gameBuildHandle: string;
  runnerKeyId: string;
  transcriptRoot: string;
  signedTranscript: SignedPrivateEvent[];
  replayAdapterVersion: string;
}
```

`configHandle`은 seed가 아니라 Config Broker가 발급한 무작위 capability입니다. Runner는 내용을 해석할 수 없습니다. private event에는 실제 전달된 key down/up 또는 opaque dispatch handle과 idempotency chain이 들어갑니다. canonical truth는 Runner에 주지 않습니다.

## 8. KnowledgeSubmission과 NormalizedDocument

Foundry 내부 지식은 JSON으로 먼저 확정합니다. 재현 에이전트에게는 임의 Markdown이 아니라 이 JSON에서 결정론적으로 생성한 문서만 전달합니다.

```ts
interface KnowledgeSubmissionV1 {
  schemaVersion: 'atlas/knowledge/1';
  inputHandoffDigests: string[];
  entities: LocalEntity[];
  claims: AtomicClaim[];
  procedures: SafeProcedure[];
  contradictions: Contradiction[];
  unknowns: Unknown[];
}

interface KnowledgeReceiptV1 {
  artifactId: string;
  inputHandoffDigests: string[];
  canonicalKnowledgeDigest: string;
  normalizedDocumentDigest: string;
  rendererVersion: string;
}
```

NormalizedDocument의 AST 허용 노드는 heading, paragraph, emphasis, strong, list, table, 같은 bundle 내부 링크뿐입니다. HTML/comment, frontmatter, code block, image, 외부·로컬 URL, data URI, zero-width/bidi control, 고엔트로피 token을 금지합니다.

submitter가 제공한 entity/claim/procedure ID, 배열 순서, 중복은 정규화 입력으로 신뢰하지 않습니다. Normalizer가 canonical semantic sort 뒤 bundle-local ordinal을 다시 발급하며, 내부 ID·snapshot digest는 재현 문서의 본문·파일명·링크·오류에 노출하지 않습니다.

## 9. Assisted 전용 부가 artifact

strict `PublicPlayHandoff`에는 hint나 자유 note가 없습니다. assisted 연구가 필요하면 별도 signed artifact만 사용합니다.

```ts
interface AssistedHintArtifactV1 {
  schemaVersion: 'atlas/assisted-hints/1';
  parentHandoffDigest: string;
  hints: Array<{
    kind: 'REVISIT' | 'UNCERTAIN' | 'POSSIBLE_RELATION' | 'POSSIBLE_SEQUENCE' | 'CONTRADICTION';
    publicEvidenceRefs: string[];
    confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  }>;
  signature: string;
}
```

free text와 임의 key/value는 금지합니다. 이 artifact는 strict KnowledgeReceipt, NormalizedDocument, ScoreReport의 parent가 될 수 없고 assisted 결과는 별도 집계합니다.

## 10. 실험 계획과 ReplayAuthorization

실험 시작 전에 Coordinator가 전체 target 집합을 봉인합니다.

```ts
interface SignedCohortPlan {
  campaignId: string;
  sourceRunId: string;
  arms: Array<'BASELINE' | 'CANDIDATE' | 'ORACLE'>;
  targetRunIds: string[];
  targetConfigCapabilities: string[];
  gameBuildHandle: string;
  probeSetDigest: string;
  agentProfileDigest: string;
  promptDigest: string;
  budgetProfileDigest: string;
  repetitionCount: number;
  randomizedOrderCommitment: string;
  signature: string;
}

interface ReplayAuthorization {
  cohortPlanDigest: string;
  track: 'REPRODUCTION' | 'TRANSFER';
  arm: 'BASELINE' | 'CANDIDATE' | 'ORACLE';
  sourceHandoffDigest: string;
  knowledgeReceiptDigest?: string;
  normalizedDocumentDigest?: string;
  targetRunId: string;
  targetConfigCapability: string;
  repetitionOrdinal: number;
  nonce: string;
  signature: string;
}
```

각 authorization은 한 번만 소비합니다. ActionTranscript는 authorization과 정확한 document digest를 부모로 서명하고, EngineOutcome은 authorization과 transcript를 부모로 서명합니다. EngineReplayPort는 독립적인 config/build/probe 인자를 받지 않고 authorization과 transcript만 받습니다. ScoreReport는 plan에 봉인된 target×arm×repetition의 완전한 집합만 수락합니다.

## 11. Artifact chain

```text
PublicPlayHandoff
  → KnowledgeReceipt
  → NormalizedDocument
  → ActionTranscript
  → EngineOutcome
  → ScoreReport
```

각 단계는 RFC 8785 JCS canonical JSON의 SHA-256 digest를 계산하고 Ed25519로 서명합니다. envelope에는 `artifactType, schemaVersion, artifactId, campaignId, track, arm, targetRunId, issuer, keyId, nonce, parentDigests, payloadDigest, contractDigest, signature`가 들어갑니다.

서명 실패, nonce 재사용, 부모 digest 교체, wrong run/track/document binding은 hard fail입니다. signing private key는 개발 fixture나 애플리케이션 프로세스에 넣지 않습니다.

## 12. 공개 금지 필드

이름을 바꾸거나 중첩해도 다음 의미의 값은 금지합니다.

- scenario/layout/visual/session seed와 RNG state
- seed/config/scenario/rule graph/content에서 파생한 hash
- canonical fact/cue/entity/probe ID와 weight
- persistent target ID, selection index, 좌표, rect, selector
- hidden state dump/hash와 engine event detail
- oracle 경로, reference action count, 성공 자기 신고
- config capability, signing secret, canary
- 절대 path, PID, cookie, storage, source map
- 다른 에이전트의 prompt, scratchpad, 대화 ID

## 13. 공통 오류

agent-visible 오류는 구체적인 내부 값을 포함하지 않습니다.

- `STALE_OBSERVATION`
- `CAPABILITY_DENIED`
- `CAPABILITY_EXPIRED`
- `OPTION_EXPIRED`
- `FOCUS_NOT_VERIFIED`
- `CAPTURE_UNAVAILABLE`
- `INPUT_NOT_DELIVERED`
- `INPUT_DELIVERY_UNKNOWN`
- `LOOP_GUARD_PAUSED`
- `RUN_NOT_ACTIONABLE`
- `ARTIFACT_REJECTED`

private 로그의 상세 오류도 seed, 정답, live key를 출력하지 않습니다.

## 14. 버전·호환성

- 스키마 version은 artifact마다 독립적으로 관리합니다.
- unknown field와 지원하지 않는 major version은 거부합니다.
- contract package digest를 모든 signed envelope에 기록합니다.
- minor version에서 필드를 추가하더라도 allowlist validator와 수신자 upgrade가 먼저 배포되어야 합니다.
- downgrade는 자동으로 하지 않습니다.
