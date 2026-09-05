# Wiki Foundry MVP Contract Pack

이 패키지는 봉인된 `PublicPlayHandoff`만 가져와 화면 증거에서 로컬 지식과 안전한 Wiki를 만듭니다. 게임 소스, seed, 정답, 점수, DOM, 좌표, target map, private log는 입력으로 받지 않습니다.

## 신뢰 경계

- 원증거는 `artifactType: PublicPlayHandoff`인 공용 SignedEnvelope와 별도 frame bytes map뿐입니다. raw/unsigned payload import는 거부합니다.
- SignedEnvelope shape와 Runner signature를 먼저 검증한 뒤 header schema가 §atlas/public-play-handoff/1§인지 확인하고 artifact/campaign/track/arm/target/contract header binding, header와 payload의 artifact/run binding을 검증합니다. 권한 있는 Runner 키로 재서명했더라도 generic schema header는 거부합니다.
- handoff의 shape와 `payloadDigest`는 `atlas_protocol` 공개 validator에 위임하고, `valid: false` 또는 비정상 validator 반환을 fail-closed로 거부합니다.
- OCR/전사는 파생물입니다. `TranscriptVerifierAttestation` 서명과 원증거 closure가 검증되지 않으면 draft로만 사용할 수 있습니다.
- `EvidenceComparisonPlan`은 선택 사항입니다. 서명된 `groups[].handoffDigests` membership만 rule-scope의 복수 실행 근거로 인정합니다. `groupRef`는 동등성 비교 외에는 사용하거나 Wiki에 출력하지 않습니다.
- `ScratchNote`는 프로세스 밖으로 export하지 않고, 승격·정규화·렌더링·receipt digest에 관여하지 않습니다.

## 공개 입력 요약

SignedEnvelope의 payload인 `PublicPlayHandoff`는 공용 계약의 `manifest`, `frames`, `observations`, `actions`로만 구성됩니다. F/A/O 참조는 `F000001`, `A000001`, `O000001` 형태의 1-based ID입니다.

정식 import API는 `files` Map 또는 plain object를 받습니다. 키 집합은 `manifest.files[].relativeName`과 정확히 같아야 하며 모든 파일의 byte length와 SHA-256을 검증합니다. 각 frame `mediaRef`에는 `frames` role 파일이 정확히 하나 대응해야 합니다. `observations.ndjson`과 `actions.ndjson`은 각각 해당 role 파일이 정확히 하나 있어야 하며, payload 배열을 공용 canonical JSON 한 줄과 LF로 직렬화한 bytes와 일치해야 합니다. 빈 배열의 NDJSON은 빈 파일입니다. 구형 `frameFiles` 단독 입력은 거부합니다.

내부 evidence `artifactDigest`와 `EvidenceComparisonPlan.groups[].handoffDigests`는 모두 signed envelope 전체의 SHA-256입니다. payload 내부 `manifest.payloadDigest`는 public payload 검증에만 사용하며 artifact identity로 사용하지 않습니다.

`manifest.validity`는 공용 enum을 따릅니다. 정상 공식 합성 증거는 `status: COMPLETE`, `validity: OFFICIAL`, `framePolicyVersion: canvas-served/v1`, `inputPolicyVersion: keyboard-restricted/v1`을 사용합니다.

## 지식 모델

- Entity 이름은 검증된 transcript에 실제로 나타나야 approved가 될 수 있습니다.
- Atomic Claim은 enum predicate, entity/literal object, evidence closure, scope를 가집니다.
- `rule` scope는 서명된 같은 `groupRef`의 서로 다른 두 `payloadDigest` 이상을 요구합니다.
- `layout`, `session`, `visual`, `unclassified` scope는 관찰된 artifact 범위를 벗어나 일반화하지 않습니다.
- Procedure는 고정 verb와 entity/claim 참조만 받습니다. key macro, action/frame 순번, timing, 좌표, selector, target handle, 임의 인자·설명을 허용하지 않습니다.
- Contradiction과 Unknown은 자유 서술이 아니라 제한된 상태/질문 enum으로 표현합니다.

## 출력

Normalizer는 submitter 식별자와 제출 순서를 폐기하고 의미 값으로 정렬해 로컬 ID를 다시 발급합니다. Renderer는 구조화 graph만 받아 고정 Markdown AST를 생성합니다. 자유 Markdown 입력은 없습니다. 내부 entity ID는 문서나 파일명에 쓰지 않고 승인 entity 순서에서 별도 `page-001.md` ordinal을 만듭니다.

전달 Wiki에는 run/frame/action/digest/comparison token/reviewer/note가 나타나지 않습니다. receipt는 신뢰 영역에 별도로 보관합니다. Markdown lint는 raw HTML, comment, frontmatter, code, 외부 URL, zero-width/bidi/private-use 문자, key macro, 고엔트로피 토큰을 거부합니다.

같은 승인 graph에서 Judge 전달용 `atlas/normalized-document/1`도 결정론적으로 생성합니다. 이 문서는 공용 `validateNormalizedDocument`를 통과한 heading/paragraph/list/table/link node만 포함하며, receipt의 `normalizedDocumentDigest`가 공용 SHA-256으로 문서를 결합합니다.

## 단계별 봉인

`sealWikiBundle`은 Coordinator가 선발급한 정확히 두 개의 `{artifactId, nonce}`와 signer metadata/private key를 받으며 모듈 안에서 ID를 만들지 않습니다. 첫 allocation은 artifact type `atlas/knowledge-receipt`와 header schema `atlas/knowledge-receipt/1`에, 둘째는 artifact type `atlas/normalized-document`와 header schema `atlas/normalized-document/1`에 사용합니다. generic `atlas/signed-envelope/1`은 허용하지 않으며 성공한 allocation 값은 다시 사용할 수 없습니다.

Knowledge Receipt envelope의 parent는 입력 Runner handoff envelope digest 전체이며 `knowledgeReceipt.inputEnvelopeDigests`와 정확히 일치해야 합니다. Normalized Document envelope의 parent는 Knowledge Receipt envelope digest 하나입니다. 두 단계 모두 공용 `createSignedEnvelope`와 `validateSignedEnvelopeShape`를 사용하고 공용 SHA-256 payload digest를 확인합니다.

## 재조사

재조사 요청은 entity 참조와 `operation`, `contrast`, `evidenceNeeded`, `maxAttempts`, `priority` enum만 사용합니다. 자유 프롬프트, 키 입력, 좌표, target 정보는 허용하지 않습니다.
