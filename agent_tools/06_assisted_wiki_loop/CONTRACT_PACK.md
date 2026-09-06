# Assisted Wiki Loop Contract Pack

이 모듈은 `KnowledgeProposal -> ASSISTED snapshot -> player knowledge context` 변환만 소유합니다.

- 모델 포트의 각 `decide`는 fresh `codex exec` 한 번만 사용하며 Runner/게임 입력 도구를 호출하지 않습니다. 통합 계층은 analysis batch마다 새 호출을 만들고 session을 이어 쓰지 않습니다.
- provider schema는 Structured Outputs 호환 부분집합만 사용하고, 개수·길이·증거 중복 등의 전체 제약은 로컬에서 독립적으로 재검증합니다.
- proposal의 evidence는 호출 시 첨부된 `Fdddddd.png` allowlist만 참조합니다.
- core만 stable ID와 revision을 발급합니다.
- 이전 snapshot은 exact schema, canonical uniqueness, deterministic order를 만족해야 합니다.
- 의미 중복 판정은 로컬의 versioned `ko-semantic-v1` 규칙만 사용합니다. 모델, embedding, 외부 호출은 병합 여부나 survivor를 결정할 권한이 없습니다.
- `ko-semantic-v1`이 항목 전체를 보수적으로 해석한 경우에만 병합하고, 해석하지 못하면 기존 exact canonical key로 되돌아갑니다. fact는 같은 page와 완전한 atom, procedure는 같은 page와 동치 title(미지원 title은 exact)·동일 step 수·순서·모든 action/cue atom, case는 condition/outcome 양쪽, question은 topic set/requested-slot set이 각각 완전 동치여야 합니다. `아직 조사하지 않은`과 `조사하지 않은`만 명시적으로 같은 `UNINSPECTED` 상태입니다.
- 부정, 전/후, 잠김/해제, 가능/불가, 수량·서수, `만`, 조건 차이는 병합 경계를 형성합니다.
- survivor는 이전 snapshot에 먼저 존재한 항목의 ID와 원문입니다. 이전 snapshot이 없거나 기존 항목과 일치하지 않는 proposal 후보끼리는 입력을 변형하지 않고 명시적 representation key로 정렬해 survivor와 stable ID를 고르므로 unordered 배열의 역순에도 byte-identical합니다.
- evidence는 sourceDigest/frameId 순서로 합집합하고 fact confidence는 최댓값을 취합니다. `64`는 지식 항목 하나가 직접 보유하는 evidenceRefs 전용 상한이지 총 근거 한도가 아닙니다. 초과분은 snapshot v3의 owner/source별 evidenceSets에 무손실 저장하며 동일 지식 문구와 stable ID는 하나만 유지합니다.
- evidence set ID는 ownerId+sourceDigest에서 core가 파생합니다. owner/source pair는 하나뿐이어야 하고, 모든 frame은 해당 source allowlist에 존재해야 하며 direct/set 중복, orphan owner, 비결정적 정렬을 거부합니다.
- 이전 snapshot은 clone한 뒤 새 proposal보다 먼저 내부 중복을 정리합니다. 게시된 과거 revision은 불변이며, 현재 r000003의 알려진 표현 중복은 다음 정상 게시 revision인 r000004를 만들 때만 정리됩니다. v1·v2는 읽기 호환하고 새 revision만 v3로 승격합니다.
- source evidence는 `artifactDigest + frameId`로 묶이고 frame은 해당 source allowlist에 실제로 존재해야 합니다.
- 봉인된 source run의 frame catalog는 현재 최대 120개이며 항목별 evidenceRefs 상한과 별도로 검증합니다. 64, 65, 120 frame source는 수용하고 121 frame source는 거부합니다.
- 모델 호출의 PNG working set은 검증된 source frame 1~12개입니다. 통합 계층은 전체 signed frame catalog를 ordinal 순서의 중복 없는 연속 batch로 정확히 분할하며, 120 frame source는 최대 10개의 fresh 호출을 사용합니다. 이 값은 source run이나 campaign 전체의 증거 한도가 아닙니다.
- 각 batch proposal은 해당 batch frame allowlist만 참조할 수 있습니다. batch ordinal은 1부터 연속되어야 하고 frame 누락·중복·순서 변경을 거부합니다.
- 모든 batch proposal을 먼저 검증한 뒤 core가 source와 revision을 한 번만 발급합니다. 어느 batch든 실패하면 snapshot, context, revision을 게시하지 않습니다.
- 다중 호출 사용량은 `TURN_DELTA`로 합산합니다. 보고된 turn과 누락 turn을 분리하고 하나라도 누락되면 completeness는 `PARTIAL`, 전부 누락되면 `UNKNOWN`입니다.
- source와 기존 snapshot이 새 source를 빈 proposal로 수용할 수 있는지는 모델 호출 전에 사전검증합니다. 이 단계의 실패는 `WIKI_INPUT_PRECHECK_FAILED`이며 모델을 호출하지 않습니다. 모델 제안의 코어 검증 실패는 `MODEL_PROPOSAL_INVALID`, 검증된 제안의 누적 병합 실패는 `WIKI_MERGE_INVALID`로 구분하고 모델 원문은 오류 메시지에 포함하지 않습니다.
- 같은 source artifact는 한 campaign에 한 번만 들어가며 중복은 모델 호출 전에 거부합니다.
- 대체 outcome은 별도 case로 보존합니다.
- Player context는 검증된 snapshot의 clone을 먼저 같은 semantic consolidation에 통과시키고 최대 32개/8192 bytes로 만듭니다. 원본은 불변이며 evidence ID, digest, 경로, 좌표, 키 이름·매크로를 포함하지 않습니다.
- 게시 파일은 exclusive-create하고 기존 revision을 덮어쓰지 않습니다.
- 모든 결과는 `ASSISTED`이며 `STRICT` 점수와 섞지 않습니다.
- 원본 Runner 산출물의 서명 트랙 `EXPLORATION`/`ASSISTED_EXPLORATION`은 source에 보존합니다. 각각 `validity: OFFICIAL`/`ASSISTED` 및 Host의 `knowledgeContext: NONE`/`ASSISTED`와 정확히 일치해야 합니다.
- Host receipt 도입 전 실행은 기본 거부하며, 명시적 legacy 옵션과 `EXPLORATION + OFFICIAL`일 때만 `knowledgeAttestation: LEGACY_OPERATOR_CONFIRMED`로 수집합니다.
- 일반 source는 연속된 Host journal과 정확한 end/seal tail을 가진 SEALED 실행이어야 합니다. 첫 model_turn_failed 바로 뒤의 exact model_restart_authorized와 model_session_reset receipt, 같은 검증 프레임을 사용한 next turn 결과가 일치해야 합니다. retry가 성공하고 이후 실패가 없으면 STANDARD/NORMAL입니다. retry가 즉시 실패하거나, retry 성공 뒤 0개 이상의 정상 turn/action을 거쳐 나중에 정확한 두 번째 MODEL_TURN_FAILED가 발생해 그 뒤 action/input 없이 RECOVERABLE_PARTIAL로 안전 봉인되면 HOST_POLICY/MODEL_DECISION_FAILED_NO_ACTION으로 옵션 없이 수용합니다. 실패는 최대 둘, restart/reset은 정확히 하나이며 세 번째 실패, 두 번째 restart/reset, 두 번째 실패의 비terminal 진행은 거부합니다.
- `model_turn_failed`는 legacy의 `turn` 전용 형식과 현재의 `errorCode` 형식을 유지하며, 두 형식 모두 optional `codexErrorInfo`를 가질 수 있습니다. 진단은 exact `{ category, httpStatus, retryable }`이고 category별 Model Port 불변식도 일치해야 합니다. non-HTTP category의 status는 `null`, overload/internal은 retryable true, 그 밖의 non-HTTP는 false입니다. connection/stream category는 status `null`, 408/409/425/429 또는 5xx일 때만 true이고, `RESPONSE_TOO_MANY_FAILED_ATTEMPTS`는 항상 false입니다. 추가·불가능 조합·malformed 필드나 원시 message/thread/path는 거부합니다.
- 정상 session rollover가 있으면 모든 `model_rollover_authorized`는 순서대로 증가하는 ordinal, 직전 성공 turn/usage input token, threshold, 현재 frame ID/hash, 누적 key count와 일치해야 합니다. 바로 뒤에 같은 ordinal과 이전 session generation+1의 exact `model_session_rotated`, 동일 frame의 `frame_served`, next turn의 `model_turn_usage`, 같은 frame의 유효한 decision 또는 exact MODEL_TURN_FAILED가 중간 이벤트 없이 연속되어야 합니다. 성공 decision 바로 뒤에는 exact `model_rollover_validated { rolloverOrdinal, sessionGeneration, turn, frameId, frameSha256 }`가 한 번 있어야 하며 rotation·authorization·served frame·decision과 전 필드를 교차 검증합니다. rollover가 첫 실패 전, reset 뒤 성공 구간, 두 번째 terminal 실패 직전 어디에 있든 reset과 하나의 session generation을 공유합니다. fresh 호출이 실패하면 validation은 없어야 하고 위 exact reset 뒤 성공하거나 안전 terminal로 끝나야 합니다. pair/validation 중복·누락·순서 역전·generation/ordinal/hash/turn 불일치·비감사 gap은 run 전체를 거부합니다. 2회 endurance 달성 여부는 primary score와 분리된 Host 진단이며, 검증 횟수가 2보다 적다는 이유만으로 정상 gameplay evidence를 폐기하지 않습니다.
- 모든 성공 model turn은 연속 turn 번호와 exact frame_served → model_turn_usage → decision, 저장 frame hash, action schema를 만족해야 하며 finish decision 뒤에는 다른 model turn이 올 수 없습니다.
- 성공 재시작 receipt는 failedTurn/nextTurn, restartOrdinal 1, frame ID/hash, 이전 key-attempt 수, 직전 reset/rollover sessionGeneration+1, nextInvocation EXEC를 서로 교차 검증합니다. reset 없는 후속 결과, 두 번째 restart, 추가 필드, 순서 변경, receipt 불일치 또는 QUARANTINED 결과는 이 정상 경로에서 거부합니다.
- 구형 QUARANTINED source는 --allow-recoverable-model-failure가 명시되고 HOST_RECEIPT, 단일 MODEL_TURN_FAILED, 실패 후 action 없음, 모든 DELIVERED 입력의 waitFrame 정산, 정상 PARTIAL end/seal, seal-bound signed PARTIAL handoff를 모두 만족할 때만 수용합니다.
- 다른 quarantine/stopCode는 어떤 옵션에서도 거부하며, model-failure 복구 옵션과 legacy unattested 옵션은 함께 사용할 수 없습니다.
- 새 Host가 동일 조건을 SEALED/PARTIAL로 봉인한 종료는 HOST_POLICY, 구형 명시 복구는 EXPLICIT_OPERATOR_RECOVERY로 source provenance에 구분합니다.
- snapshot v3와 source v2는 finalState, terminationKind, stopCode, acceptanceBasis, journalSha256를 영구 보존합니다. v1 snapshot은 provenance를 MIGRATED_LEGACY로 보강하고, v2 snapshot은 기존 provenance를 유지한 채 원본을 수정하지 않고 다음 revision에서 v3로 승격합니다.
- 종료 provenance는 Wiki snapshot/source 전용이며 Player context로 내보내지 않습니다.

06은 source 하나의 전체 frame을 다중 호출로 분석해 누적 snapshot 하나를 원자적으로 게시합니다. campaign 수준의 선제 checkpoint, 물리 episode Wiki, 자동 topic/episode shard와 top-K 관련 context 선택은 `07_checkpoint_campaign` 및 trusted integration adapter의 별도 계약입니다. 06의 120 frame 상한은 그때도 각 sealed episode source에 적용되며 게임 전체 지식량 한도로 승격되지 않습니다.
