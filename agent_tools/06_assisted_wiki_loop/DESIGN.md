# 06 Assisted Wiki Loop 설계

## 목적과 평가 구분

이 모듈은 봉인된 플레이 증거를 누적 Wiki로 만들고, 다음 플레이에는 그 Wiki의 제한된 의미 정보만 제공하는 반복 탐사 경로입니다. 결과는 항상 `ASSISTED`로 표시하며, 사전 지식이 없는 공식 `STRICT` 평가와 합산하지 않습니다.

```text
sealed Vision run (or explicitly recovered legacy model-failure run)
  -> verified public handoff
  -> every signed PNG, partitioned in ordered batches of at most 12
  -> one fresh Wiki Agent per batch
  -> strict KnowledgeProposal deltas
  -> validate every delta, then one deterministic merge/render
  -> immutable Wiki revision
  -> bounded player-context.json
  -> next Vision Player (optional ASSISTED input)
```

Wiki는 플레이 중에 직접 수정되지 않습니다. 플레이가 종료·봉인된 뒤 별도의 fresh Wiki Agent가 제안하고, 신뢰된 코어가 ID 발급·중복 병합·대체 사례 보존·문서 렌더링을 수행합니다.

## 모듈 경계

- `src/model`: 검증된 PNG 1~12개와 그 batch의 frame allowlist를 fresh Codex 프로세스 하나에 제공하고 strict `KnowledgeProposal`만 받습니다. provider schema는 OpenAI Structured Outputs가 지원하는 부분집합만 사용하며, 증거 중복을 포함한 모든 의미 제약은 반환 후 로컬 projector가 다시 강제합니다. Runner 도구와 게임 입력 권한은 없습니다.
- `src/core`: 순서가 고정된 모든 batch delta가 source frame catalog를 중복·누락 없이 정확히 분할하는지 검증하고, 이전 snapshot과 한 번만 결정론적으로 병합합니다. 모델이 ID, revision, digest를 정하지 못합니다.
- `integration/assisted_wiki_loop`: Vision run의 Host 종료 journal, Runner 서명·manifest hash·artifact digest 결합을 검증하고 model/core를 조립합니다. 모든 signed frame을 ordinal 순서로 최대 12장씩 나누고 batch마다 새 Wiki Agent를 호출합니다. 모든 batch가 성공해야 단 하나의 revision을 게시하며 하나라도 실패하면 기존 campaign은 바뀌지 않습니다. 정상 실행은 `SEALED`만 수용합니다. 정확히 한 번 실패한 모델 세션이 감사 가능한 reset 뒤 성공한 경우도 아래의 좁은 정상 계약으로 수용하며, 구형 `QUARANTINED` 실행은 별도의 복구 계약에서만 예외입니다.
- `05_vision_agent_host`: 선택적으로 `player-context.json`을 받아 현재 픽셀을 재확인하도록 프롬프트에 삽입합니다. Wiki 파일이나 증거 경로는 모델에 노출하지 않습니다. Host가 context 유무로 Runner의 서명 트랙을 각각 `EXPLORATION` 또는 `ASSISTED_EXPLORATION`으로 고정합니다.

## 한도의 의미와 규모 경계

현재의 수치 한도는 서로 다른 처리 단위에 적용되며 게임이나 campaign 전체의 지식량 한도가 아닙니다.

- `64`: fact, procedure, case, open question 한 항목이 직접 보유하는 `evidenceRefs`의 상한입니다.
- `64`를 넘는 동일 항목의 근거: 지식을 복제하지 않고 snapshot v3의 source별 `evidenceSets`에 계속 누적합니다. 따라서 64는 누적 근거 총량 제한이 아닙니다.
- `120`: 현재 봉인된 source run 하나가 보유할 수 있는 frame catalog의 상한입니다. 65 frame source는 유효하며 항목별 64개 제한으로 거부하지 않습니다.
- `1~12`: Wiki 모델 한 번에 제공하는 검증 PNG working set입니다. source의 모든 frame을 이 크기로 순서대로 분할하므로 65 frame source는 `12/12/12/12/12/5`의 fresh 호출 6회가 필요합니다.
- `10`: 120 frame source에서 발생할 수 있는 fresh Wiki Agent 호출의 최대 횟수입니다. 이는 campaign 전체 호출 한도가 아니라 source 하나의 현재 처리 상한입니다.

현재 06의 처리 단위는 `one sealed run → one source → ordered multi-batch analysis → one cumulative snapshot`입니다. 호출별 12장 경계는 전체 source의 나머지 frame을 버리는 표본 추출 한도가 아닙니다. batch 결과는 독립 revision으로 게시되지 않고 모두 검증된 뒤 한 revision으로 원자적으로 합쳐집니다.

긴 게임의 episode 분리는 `07_checkpoint_campaign`이 담당합니다. Host가 rollover보다 낮은 선제 threshold 또는 키·프레임 경계에서 안전하게 PARTIAL 봉인하면, 해당 segment를 독립적인 물리 Wiki에 게시하고 topic/episode shard를 자동 생성한 뒤 trusted integration의 routing hint와 episode에 맞는 top-K context만 다음 fresh Player 세션에 전달합니다. 따라서 120 frame은 episode source 하나의 상한으로 남고 campaign 전체 지식량은 여러 episode와 routing revision으로 확장됩니다. 현재 live adapter의 routing text는 고정된 episode hint이고 시각 텍스트 추출기는 아직 연결하지 않았습니다. 게임 build별 namespace 분리도 이후 trusted adapter가 추가로 제공해야 합니다.

## 지식 구조와 병합

새 Snapshot은 `atlas/assisted-wiki-snapshot/3`이며 revision, source artifact, 원본 실행의 서명된 exploration track, 종료 provenance, page, fact, procedure, case, open question과 초과 근거 집합을 보관합니다. 기존 v1과 v2는 모두 읽기 호환됩니다. 다음 revision을 만들 때만 메모리에서 v3로 승격하고, 이미 게시된 revision 파일은 수정하지 않습니다. v1 source에는 확인할 수 없는 provenance를 `MIGRATED_LEGACY/LEGACY_UNRECORDED`로 명시해 추정하지 않으며 v2의 provenance는 그대로 유지합니다.

새 source는 `finalState`, `terminationKind`, `stopCode`, `acceptanceBasis`, Host journal SHA-256, 실패 turn과 end/seal 검증 결과를 영구 보존합니다. 각 evidence는 `source artifact digest + frame ID`로 결합되어 다른 실행의 같은 프레임 번호가 충돌하지 않습니다. 같은 source artifact는 모델 호출 전에 거부되어 한 실행으로 revision을 반복 생성할 수 없습니다.

의미 중복 병합은 core 내부의 versioned `ko-semantic-v1` fingerprint가 전담합니다. 이 규칙은 한국어 표현을 무제한으로 추측하지 않고, 지원하는 문장 형식 전체가 해석된 경우에만 다음 경계를 적용합니다.

- fact: 같은 page 안에서 완전히 같은 관찰 atom
- procedure: 같은 page, 동치 title, 같은 step 수와 순서, 각 step의 action atom과 cue atom이 모두 동치. 지원하지 않는 title은 exact canonical title 자체가 경계
- case: condition atom과 outcome atom이 모두 동치
- open question: topic 집합과 요청 slot 집합이 모두 동치

부정, 전/후, 잠김/해제, 가능/불가, 수량·서수, 조사 `만`, 추가 조건은 fingerprint에 보존되거나 해석 실패를 일으켜 서로 합쳐지지 않습니다. `아직 조사하지 않은`과 `조사하지 않은`은 complete condition parser가 같은 `UNINSPECTED` 상태로 명시하는 유일한 생략 표현입니다. 지원하지 않는 표현은 기존 exact canonical key로 되돌아가므로 부분 일치만으로 병합하지 않습니다. 따라서 낮/밤처럼 title 조건이 다르거나 같은 조건의 다른 outcome, step 하나가 다른 절차도 별도 지식으로 남습니다. 모델은 텍스트와 evidence를 제안할 뿐 ID나 병합 판단을 정할 수 없고, embedding이나 외부 의미 서비스도 사용하지 않습니다.

새 revision을 만들 때 core는 먼저 이전 snapshot을 clone하고, 그 clone에 남은 legacy 표현 중복을 결정론적으로 consolidation한 다음 새 proposal을 병합합니다. 이전 snapshot에서 먼저 존재하던 항목의 ID와 원문이 survivor가 되고 새 proposal 항목은 이를 교체하지 않습니다. 기존 survivor가 없는 proposal 후보는 page별 unordered collection을 별도 배열로 모아 명시적 canonical+원문 representation key로 정렬한 뒤 처리합니다. 입력 객체와 배열은 변형하지 않으며, 같은 proposal의 배열 순서를 뒤집어도 survivor, stable ID, evidence 순서와 snapshot bytes가 같습니다. procedure의 step 순서는 의미이므로 정렬하지 않습니다.

evidence는 `sourceDigest + frameId` 순서로 합집합하며 fact confidence는 `TENTATIVE < OBSERVED`의 최댓값을 취합니다. 각 지식 항목은 정렬상 처음 64개를 기존 `evidenceRefs`에 직접 보유합니다. 초과분은 같은 지식 ID를 owner로 삼는 source별 `evidenceSets`에 저장합니다. set ID도 core가 `ownerId + sourceDigest`에서 파생하며 source frame allowlist, direct/set 중복, orphan owner와 정렬을 검증합니다. 따라서 동일 문구의 65번째 근거도 지식 문구·stable ID를 바꾸거나 증거를 버리지 않고 누적됩니다.

이 처리는 snapshot schema를 v3로 올립니다. 이미 게시된 r000003 같은 v2 파일은 수정하지 않으며, 다음 정상 실행이 r000004를 게시할 때 v3로 승격되고 알려진 질문·사실·절차 표현 중복도 함께 정리됩니다. 같은 consolidation을 반복 적용해도 survivor ID와 출력 순서는 바뀌지 않으므로 player context에도 한 대표 guidance만 들어갑니다.

Markdown은 snapshot에서 결정론적으로 생성됩니다. 64개를 넘는 항목은 본문에 전체 근거 수와 direct/extended 수를 표시하고 `wiki/evidence/<ownerId>.md`에서 모든 source/frame 근거를 감사할 수 있습니다. 다음 Player에게 주는 context에서는 evidence set, ID, digest, 경로, 좌표, 구체 키 이름과 매크로를 제거합니다.

## 다음 플레이 컨텍스트

`player-context.json`의 정확한 구조는 다음과 같습니다.

```json
{
  "schemaVersion": "atlas/player-knowledge-context/1",
  "track": "ASSISTED",
  "revision": 1,
  "guidance": [
    { "kind": "FACT", "title": "...", "body": "..." }
  ]
}
```

최대 32개, 4KB 기본 생성 상한(검증 상한 8KB)입니다. context 생성은 snapshot을 검증한 뒤 clone하고, clone의 의미 중복을 먼저 consolidation하여 아직 새 revision으로 승격되지 않은 구 snapshot도 중복 guidance로 예산을 잠식하지 않게 합니다. 입력 snapshot과 게시 revision은 수정하지 않습니다. Supervisor는 이를 비신뢰 JSON 데이터로 표시하고 현재 픽셀과 대조하도록 지시합니다. 모순이나 새 결과가 보이면 안전하게 탐사하고 해당 프레임을 북마크해야 하며, 이전 행동을 그대로 재생할 수 없습니다. 한 fresh frame당 한 행동, 허용 키, 입력 budget, delivery fence는 기존과 같습니다.

## 증거와 게시 원자성

Ingress는 self-contained Runner 키만 믿지 않고 operator key ID, Host journal의 연속 seq/시간, 정확한 종료 tail, Host seal receipt의 public artifact digest까지 결합합니다. manifest 파일 수·총 bytes·경로를 제한하고 서명 검증 시 읽은 PNG bytes를 전용 work directory에 exclusive-copy한 뒤 그 복사본만 모델에 제공합니다.

Host journal에 `model_turn_failed`가 있으면서 최종 상태가 정상 `SEALED`라면 Ingress는 단일 audited restart를 별도 검증합니다. 첫 실패 record 바로 뒤에 exact `model_restart_authorized`, exact `model_session_reset`, 동일 frame ID/hash의 다음 `frame_served`, 같은 next turn의 사용량 record와 모델 결과가 연속되어야 합니다. authorization의 failed/next turn, restart ordinal 1, frame 결합, 누적 key-attempt 수와 reset receipt의 직전 session generation+1/next invocation을 교차 검증하며 raw thread ID는 사용하지 않습니다.

retry가 성공하고 이후 모델 실패가 없으면 `STANDARD/NORMAL`로 보존합니다. retry가 즉시 두 번째 MODEL_TURN_FAILED로 끝나는 기존 경로뿐 아니라, retry 성공 뒤 0개 이상의 정상 turn/action을 수행한 후 나중에 두 번째 실패가 발생하는 경로도 같은 원칙을 적용합니다. 두 번째 실패 뒤 action/input이 전혀 없고 `RECOVERABLE_PARTIAL → termination → ENDING → SEALING → SEALED/PARTIAL` exact tail이면 `HOST_POLICY/MODEL_DECISION_FAILED_NO_ACTION`으로 옵션 없이 수용합니다. 모든 성공 turn은 1부터 연속된 번호, exact frame_served → model_turn_usage → decision, 저장 frame hash와 action schema를 만족해야 하며 finish 뒤 추가 turn은 금지합니다. 두 번째 실패가 nonterminal이거나 부작용 뒤에 종료되면 거부합니다. 실패 최대 둘과 restart/reset 정확히 하나를 벗어나도 거부합니다.

`model_turn_failed` record는 기존 `turn` 전용 형식과 `errorCode` 포함 형식을 계속 수용하며 양쪽에 optional `codexErrorInfo`를 허용합니다. 이 진단은 exact 세 필드뿐 아니라 Model Port가 생성하는 category별 의미도 검증합니다. non-HTTP category는 status가 `null`이어야 하고 overload/internal만 retryable true입니다. connection/stream category는 status가 `null`, 408/409/425/429 또는 5xx일 때만 retryable true이며, too-many-failed-attempts는 항상 false입니다. unknown category, 불가능한 status/retryable 조합, 추가 필드, 타입·범위 오류는 수용하지 않으며 provider 원문·thread/turn ID·경로를 Wiki source로 복사하지 않습니다.

정상 `SEALED` journal의 선제적 session rollover도 독립 감사 체인으로 검증합니다. `model_rollover_authorized`의 completed/next turn, 순차 rollover ordinal, 직전 성공 usage의 input token과 threshold, 현재 저장 frame ID/hash, 누적 key count가 모두 맞아야 합니다. 바로 다음 record는 같은 ordinal과 직전 reset/rotation generation보다 정확히 1 큰 `model_session_rotated`여야 하고, 이어서 동일 frame의 `frame_served`, next turn의 exact usage와 같은 frame의 decision 또는 exact MODEL_TURN_FAILED가 연속되어야 합니다. 성공 decision이면 그 직후, side effect보다 앞선 exact `model_rollover_validated`의 ordinal/generation/turn/frame/hash가 authorization·rotation·served frame·decision과 모두 일치해야 합니다. fresh 호출 실패에는 validation이 없어야 하며 같은 frame의 exact reset/retry가 성공하거나 위 안전 terminal로 끝나는 경우만 수용합니다. rollover는 첫 실패 전과 audited reset 이후의 정상 구간 모두에서 허용되며, failure-reset과 하나의 session generation을 공유하되 각 authorization 의미와 ordinal은 섞지 않습니다. 중간 비감사 record, pair 또는 validation 중복·누락·역전, generation·ordinal·hash·turn 변조는 전체 source를 거부합니다. Host의 2회 endurance PASS/INSUFFICIENT_DURATION은 primary score와 분리된 진단이므로, 검증된 rollover가 두 번 미만인 정상·안전 종료 실행도 gameplay evidence 수용 규칙은 바뀌지 않습니다.

reset record 없이 이어진 결과, 중복 restart/reset, out-of-order 또는 추가 필드가 있는 event, receipt 관계 불일치는 모두 정상 수용에서 제외됩니다. 세 번째 model failure는 항상 거부하며 두 번째 model failure는 위 exact safe terminal에서만 허용합니다. `QUARANTINED` 실행은 성공 재시작으로 승격하지 않고 아래의 명시적 recovery 정책만 적용합니다.

Runner의 private receipt, public handoff, private Judge envelope는 모두 동일 exploration track을 서명합니다. `EXPLORATION`은 `manifest.validity: OFFICIAL`, `ASSISTED_EXPLORATION`은 `manifest.validity: ASSISTED`와 묶이며 상충 조합은 봉인기가 거부합니다. Ingress는 이 조합과 Host journal의 `knowledgeContext: NONE/ASSISTED` 영수증을 다시 교차 검증한 뒤 원본 track을 snapshot source에 보존합니다. Wiki의 누적 산출물 자체는 두 경우 모두 `ASSISTED`이고 공식 STRICT 점수에는 들어가지 않습니다.

성공한 결과는 `revisions/rNNNNNN`으로 원자적으로 rename되어 게시됩니다. 기존 revision과 snapshot은 덮어쓰지 않습니다. batch 하나라도 모델·schema 검증에 실패하거나 서명 검증이 실패하면 새 revision이 생기지 않습니다. 사용량은 batch별 turn delta를 합산하며 누락된 호출이 있으면 전체를 0으로 간주하지 않고 `PARTIAL`로 표시합니다.

기능 도입 전 Vision 산출물은 Host knowledge receipt가 없으므로 기본적으로 거부합니다. 운영자가 `--allow-legacy-unattested`를 명시한 경우에만 `EXPLORATION + OFFICIAL` 조합을 가져오며, source의 `knowledgeAttestation`을 `LEGACY_OPERATOR_CONFIRMED`로 영구 보존합니다. 새 산출물은 반드시 `HOST_RECEIPT`여야 합니다.

구형 Host가 모델 결정을 받지 못해 `QUARANTINED`했더라도 무조건 수용하지 않습니다. 운영자가 `--allow-recoverable-model-failure`를 명시하고, `HOST_RECEIPT`, 단 하나의 `MODEL_TURN_FAILED`, 실패 turn의 action 부재, 모든 `DELIVERED` 입력의 waitFrame 정산, 정상 `PARTIAL` end/seal, seal-bound signed PARTIAL handoff가 모두 확인될 때만 `EXPLICIT_OPERATOR_RECOVERY`로 수용합니다. 다른 quarantine/stopCode는 옵션이 있어도 거부합니다. 이 옵션은 `--allow-legacy-unattested`와 함께 사용할 수 없습니다.

새 Host가 같은 안전 조건을 자체 확인해 `RECOVERABLE_PARTIAL → termination → ENDING → SEALING → SEALED`로 종료한 경우에는 `HOST_POLICY`로 구분합니다. 두 복구 경로의 `terminationKind`는 `MODEL_DECISION_FAILED_NO_ACTION`이며 다음 Player context에는 provenance가 포함되지 않습니다.

## 알려진 경계

- 로컬 bootstrap의 Runner 서명 키는 실행마다 생성됩니다. 현재 Host seal과 디렉터리 권한을 신뢰하며, 운영 배포에서는 외부 Key Service/ACL trust anchor가 필요합니다.
- `PARTIAL` 플레이도 관찰된 증거 범위에서 assisted Wiki 후보를 만들 수 있지만, 보지 못한 콘텐츠를 없다고 단정하지 않습니다.
- Wiki Agent와 다음 Player는 Codex CLI 사용량을 각각 소비합니다. CLI가 실제 금액을 주지 않으므로 비용은 `UNAVAILABLE`로 기록합니다.
- 서브초 전투나 연속 영상 요약은 이 버전의 범위가 아닙니다.
