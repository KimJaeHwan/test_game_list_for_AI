# 02 Wiki Foundry 설계

## 1. 제품 책임

Wiki Foundry는 정답을 아는 문서 생성기가 아닙니다. 봉인된 공개 플레이 증거를 근거 추적 가능한 지식 그래프로 바꾸고, 그 그래프를 결정론적 위키로 컴파일하는 로컬 도구입니다.

책임:

- PublicPlayHandoff 무결성 검사와 원본 불변 보관
- Evidence Library와 화면 전사
- 로컬 entity 식별·병합·분리
- 원자 claim, 조건, scope, 반례 관리
- procedure, 분기, 실패와 복구 구조화
- contradiction, unknown, 재조사 요청 관리
- review를 통과한 Wiki snapshot 생성

비목표:

- 화면 조작과 키 입력
- game source, canonical ID, seed, 점수 접근
- 성공·정답 판정
- 외부 LLM API나 위키 서비스 업로드

## 2. 입력과 원증거

원증거 입력은 [Atlas Protocol](../packages/atlas_protocol/CONTRACT.md)의 `PublicPlayHandoff`뿐입니다. 여러 공식 run을 비교할 때만 Trusted Coordinator가 별도로 서명한 `EvidenceComparisonPlan`을 함께 받습니다. 비교 plan은 handoff 봉인 뒤 생성되며 Runner나 Wiki Agent가 membership을 정할 수 없습니다. manifest에 나열된 모든 파일의 hash와 크기를 검사하고 하나라도 다르면 전체 import를 거부합니다.

신뢰 가능한 원증거는 다음뿐입니다.

1. AI가 실제로 본 servedFrame 바이트
2. Runner가 봉인한 제한 action receipt
3. observation과 frame/action의 순서 관계

OCR, 위치명, 화자명, 장면 분류, 분석 메모는 Foundry가 만든 derived data이며 원증거가 아닙니다. imported bytes는 `imports/<artifact-id>/raw/`에서 불변으로 보관하고 주석·병합·전사는 별도 store에 둡니다.

같은 artifactId+같은 digest는 idempotent import입니다. 같은 artifactId+다른 digest, unknown field, forbidden field, run-local ID 충돌은 거부합니다.

## 3. Evidence Library

UI는 다음 3열을 기본으로 합니다.

- 왼쪽: run, observation, action 전후, 인용/미인용, review 상태 필터
- 중앙: servedFrame, 앞·뒤 frame, 공개 action 문맥
- 오른쪽: 이 observation을 인용한 entity/claim/procedure/contradiction

```ts
interface DerivedTranscript {
  transcriptId: string;
  observationId: string;
  text: string;
  method: 'human' | 'ocr' | 'agent';
  reviewStatus: 'draft' | 'confirmed' | 'rejected';
}

interface EvidenceBundle {
  evidenceId: string;
  observationIds: string[];
  role: 'support' | 'counterexample' | 'context' | 'procedure-step';
  transcriptIds: string[];
  leafDigest: string;
}
```

transcript는 픽셀의 전사이지 독립 증거가 아닙니다. strict에서 Wiki Agent가 만든 transcript는 `draft`만 될 수 있습니다. 격리된 Transcript Verifier가 handoff digest, observation, servedFrame hash, evaluator-only pixel region, NFC text를 서명해야 `confirmed`가 됩니다. 사람의 자유 수정은 ASSISTED로 강등합니다. claim의 provenance는 항상 `observation → frame → sealed file digest`까지 닫혀야 합니다.

자유형 ScratchNote는 review 편의를 위해 둘 수 있지만 `exportPolicy: never`입니다. note는 evidence/citation, claim 승격, entity label, procedure, review artifact, 재조사 요청, renderer input, KnowledgeReceipt에서 참조·복사·요약할 수 없고 process 밖으로 직렬화하지 않습니다. publish 가능한 문자열은 sealed evidence closure가 있는 typed field, ontology enum, attested transcript만 허용합니다. ScratchNote를 바꾸어도 knowledge digest, Markdown bytes, 평가 입력이 한 바이트도 바뀌면 안 됩니다. Explorer의 chain-of-thought나 discovery memo는 import하지 않습니다.

## 4. Entity Resolution

Foundry는 canonical ID가 아니라 자체 `LocalEntityId`만 만듭니다.

```ts
interface LocalEntity {
  id: string;
  type:
    | 'region' | 'npc' | 'quest' | 'item' | 'encounter'
    | 'recipe' | 'shop' | 'offer' | 'worldState' | 'rumor';
  primaryName: string;
  aliases: Array<{ value: string; evidenceIds: string[] }>;
  status: 'candidate' | 'resolved' | 'split' | 'deprecated';
  evidenceIds: string[];
}
```

- 같은 이름만으로 자동 병합하지 않습니다.
- 동일 역할·장면·외형을 뒷받침하는 evidence가 있어야 merge proposal을 만듭니다.
- merge 뒤에도 redirect와 이력을 남기고 split 시 evidence/claim 연결을 복구합니다.
- 이름은 confirmed transcript의 연속 문자열이어야 합니다.
- 이름이 없으면 `미명명 NPC 01`처럼 type+로컬 ordinal을 사용합니다.
- Agent가 제출한 ID, 배열 순서, 중복은 신뢰하지 않습니다. Foundry가 workspace ref를 발급하고, scored export의 Normalizer가 canonical semantic sort 뒤 bundle-local ordinal을 다시 발급합니다.
- workspace/entity/claim/procedure ID와 snapshot digest는 Wiki 본문·파일명·link href·오류 메시지에 노출하지 않습니다.

## 5. Atomic Claim과 Scope

한 claim은 한 subject, predicate, object만 표현합니다.

```ts
type EvidenceScope =
  | { kind: 'rule'; groupRef: string; supportingRuns: string[] }
  | { kind: 'layout'; supportingRuns: string[] }
  | { kind: 'session'; supportingRuns: string[] }
  | { kind: 'visual'; supportingRuns: string[] }
  | { kind: 'unclassified'; supportingRuns: string[] };

interface AtomicClaim {
  id: string;
  subject: string;
  predicate: PublicPredicate;
  object: EntityRef | AllowedLiteral;
  polarity: 'positive' | 'negative';
  qualifiers: AllowedQualifiers;
  scope: EvidenceScope;
  status: 'draft' | 'supported' | 'verified' | 'disputed' | 'refuted' | 'deprecated';
  confidence: number;
  supportEvidenceIds: string[];
  counterEvidenceIds: string[];
}
```

scope 값은 seed나 layout ID가 아니라 “어느 공개 run들에서 성립했는가”만 표현합니다. groupRef와 membership은 signed EvidenceComparisonPlan에서 immutable하게 import하며 Agent가 작성할 수 없습니다. unknown/duplicate/cross-group run과 OFFICIAL이 아닌 run을 섞으면 claim 전체를 거부합니다. 차이의 원인을 모르면 `unclassified`로 둡니다.

승격 규칙:

- `draft`: 근거가 없어도 되지만 Wiki 사실 본문에 나오지 않음
- `supported`: 유효한 support evidence 1개 이상
- `verified`: 직접 outcome 근거 또는 독립 run 2개 이상의 일치
- `disputed`: support와 counterexample이 공존
- `refuted`: 반례가 채택되었지만 이력은 보존
- negative claim은 통제된 실패 또는 명시적인 화면 문구 없이는 verified 불가
- scope 없는 claim은 publish 불가
- confidence는 status를 대체하지 않음

predicate, qualifier, literal type은 공개 ontology enum만 허용합니다. 좌표, key code, action ordinal, frame hash, option token, URL, 긴 hex/base64 값은 object가 될 수 없습니다.

primaryName, alias, 문자열 literal은 attested transcript의 연속 문자열만 허용합니다. 확인되지 않은 대상은 시스템이 생성한 중립 local ordinal로 표시하며 Agent가 label text를 정할 수 없습니다.

## 6. Procedure 모델

절차는 입력 매크로가 아니라 콘텐츠 의미의 순서입니다.

```ts
type ProcedureVerb =
  | 'travel-to' | 'talk-to' | 'inspect' | 'acquire'
  | 'craft' | 'exchange' | 'use-item'
  | 'set-world-state' | 'choose-branch' | 'verify-outcome';

interface SafeProcedureStep {
  order: number;
  verb: ProcedureVerb;
  targetEntityId?: string;
  preconditionClaimIds: string[];
  expectedClaimIds: string[];
  consumes?: Array<{ itemEntityId: string; count: number }>;
  produces?: Array<{ entityId: string; count: number }>;
  onFailure?: 'retry-observation' | 'use-alternative' | 'return-to-prerequisite' | 'stop';
  evidenceIds: string[];
}
```

이 객체는 `additionalProperties: false`입니다. `args/details/note` 같은 자유 확장 필드가 없고 verb enum, Foundry entity ref, claim ref, consumes/produces, onFailure enum만 저장합니다.

금지되는 표현:

- `ArrowDown, ArrowDown, Enter` 같은 key sequence
- source action/frame/receipt ordinal
- “세 번째 카드”, “오른쪽 위”, 절대·상대 좌표
- target handle, DOM selector, accessibility label
- delay나 timing pattern
- 임의 색상·픽셀 속성, opaque token, 자유형 detail

렌더러는 `[선행조건] 방수 잠수등 보유 → [행동] 침수 광산으로 이동 → [기대] 광산 진입 상태 확인`처럼 semantic sentence만 생성합니다. source action은 근거 문맥일 수 있지만 문서 행동으로 복사할 수 없습니다.

## 7. Contradiction과 Unknown

다음을 자동 탐지합니다.

- 같은 subject+predicate+scope에서 다른 object
- positive/negative 충돌
- 상충하는 alias/type
- procedure prerequisite 순환
- 한 run의 layout/session evidence만으로 rule을 verified한 경우
- 근거가 없는 procedure step

해결할 때 원 claim을 삭제하지 않고 case, 선택 근거, review event를 보존합니다. 확인되지 않은 사실은 `Unknown`으로 남기며 unknown 자체에 보상을 주지 않습니다.

## 8. 제한된 재조사 요청

strict 평가는 단방향 handoff만 사용합니다. 재조사는 별도 interactive/assisted 트랙에서 fresh Inspector에게 요청합니다.

```ts
interface ReinspectionRequest {
  requestOrdinal: number;
  subject: {
    entityType: PublicEntityType;
    confirmedVisibleLabelRef?: string;
    coordinatorSubjectOrdinal?: string;
  };
  operation: 'observe' | 'interact-and-observe' | 'compare-two-conditions';
  contrast?: {
    variable:
      | 'world-state-label' | 'possessed-item'
      | 'interaction-order' | 'branch-choice'
      | 'repeat-observation' | 'unknown';
    visibleValueRefs?: string[];
  };
  evidenceNeeded: Array<
    'before-frame' | 'after-frame' | 'visible-text'
    | 'success-outcome' | 'failure-outcome'
  >;
  maxAttempts: 1 | 2 | 3;
  priority: 'low' | 'medium' | 'high' | 'critical';
}
```

`confirmedVisibleLabelRef`와 `visibleValueRefs`는 기존 attested literal만 가리킵니다. 미명명 대상은 Agent 문자열 대신 Coordinator가 만든 `SUBJECT_01` 형식의 ordinal을 사용합니다. 자유 prose, key sequence, 좌표, 이전 frame/action ID, seed/run token은 넣을 수 없습니다. Judge/Coordinator가 이 요청을 capability로 바꾸며 Foundry는 Runner를 직접 호출하지 않습니다.

## 9. 위키 정보 구조

```text
wiki/
  README.md
  regions/index.md
  npcs/index.md
  quests/index.md
  items/index.md
  encounters/index.md
  crafting/index.md
  shops/index.md
  systems/index.md
  procedures/index.md
  rumors/index.md
  open-questions/index.md
```

홈에는 처음 플레이하는 사용자를 위한 의미 기반 절차, 퀘스트 선행 관계, 아이템 획득처/사용처 역색인, 지역/NPC/제작/상점 링크, contradiction/unknown 수를 둡니다.

각 페이지는 다음 정보를 표현합니다.

- 퀘스트: 선행조건, 시작·완료 대상, 목표, 필요 아이템, 보상, 분기, 실패·복구
- 아이템: 획득처, 제작·교환, 소비처, 수량, 대체재
- 지역: 진입조건, 연결 대상, NPC·조우·시설, 보이는 세계 상태 변화
- NPC: 역할, 제공 기능, 퀘스트·상점, 검증 진술과 소문
- procedure: 의미 행동, 조건, 기대 변화, 대안과 복구

재현 에이전트에게 가는 scored Wiki에는 source run ID, frame/action 번호, hash, comparison token, reviewer identity가 없습니다. provenance map은 Judge 전용 attachment로 보관합니다.

## 10. 결정론적 생성과 숨은 채널 방지

Markdown은 승인된 구조화 graph에서만 생성합니다.

- Unicode NFC, UTF-8 no BOM, LF, 파일 끝 newline 1개
- 고정된 heading/table/list template
- `page type rank → stable local entity ID → claim ID` 순서
- 현재 시각, random UUID, filesystem 순서 사용 금지
- mutable 이름 대신 stable page ID 사용, rename은 redirect
- 직접 `.md` 편집 금지
- 동일 graph를 세 번 build하면 file bytes와 hash map이 같아야 함

재현용 문서에서는 자유 서술을 제외하고 ontology enum, confirmed visible label, deterministic template만 사용합니다. AST는 heading, paragraph, emphasis, strong, list, table, 내부 링크만 허용합니다.

HTML/comment, frontmatter, code, image, 외부 URL, data URI, zero-width/bidi/private-use 문자, 32자 이상 hex/base64형 token, 비정상 반복·공백을 거부합니다. page 24 KiB, bundle 512 KiB, 표 200행, nesting depth 4를 기본 상한으로 고정하고 profile version 없이 바꿀 수 없습니다.

## 11. Review와 Snapshot

상태는 `working draft → review candidate → approved snapshot → superseded`입니다.

review 단위는 claim, entity merge/split, procedure step/scope, contradiction resolution, unknown 승격입니다. 승인 뒤 graph가 바뀌면 승인을 무효화하고 다시 검토합니다.

snapshot ID는 canonical graph, input handoff digest, ontology version, renderer version으로 계산합니다. 표시용 semver와 별개로 이 digest가 최종 식별자입니다. snapshot digest는 evaluator-only이며 Reproduction Agent의 문서, 경로, 링크, 오류에 포함하지 않습니다.

## 12. 내부 모듈과 CLI

```text
src/contracts/       public handoff, knowledge, request schema
src/import/          hash 검증과 immutable store
src/evidence/        frame/transcript/citation
src/entities/        merge/split/redirect
src/claims/          atomic claim과 promotion gate
src/procedures/      semantic DSL과 lint
src/issues/          contradiction, unknown, request
src/review/          revision, approval, snapshot
src/markdown/        deterministic renderer
src/ui/              로컬 review UI
```

```text
foundry import <handoff>
foundry validate <workspace>
foundry build <workspace> --out <dir>
foundry diff <snapshotA> <snapshotB>
foundry export-requests <workspace>
```

## 13. MVP 수용 기준

- 변조 archive, unknown field, seed/좌표/DOM/target/private field를 import에서 거부합니다.
- imported servedFrame은 모든 편집 후에도 byte hash가 같습니다.
- 모든 published claim이 sealed frame digest까지 100% 역추적됩니다.
- scratch note에 seed나 key sequence를 써도 knowledge/Markdown digest가 변하지 않습니다.
- scratch note의 문자열을 entity/claim/procedure/request/review로 복사하거나 참조할 수 없습니다.
- action transcript를 procedure로 복사하려는 fixture가 schema 단계에서 실패합니다.
- 단일 run 근거로 rule claim을 verified할 수 없습니다.
- merge→split 뒤 evidence와 claim link 손실이 없습니다.
- 같은 graph를 세 번 build해 모든 Markdown hash가 같습니다.
- submitter ID/order를 바꿔도 Normalizer가 같은 canonical output을 만듭니다.
- forbidden AST node, zero-width, URL, 고엔트로피 token이 0건입니다.
- 좌표와 target map 없이 entity index, 획득처/사용처, 선행조건, procedure를 생성합니다.
- 모든 내부 링크가 유효하고 orphan published entity가 없습니다.
