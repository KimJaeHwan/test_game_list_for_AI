# AI 콘텐츠 탐사·위키화 시스템

이 디렉터리는 AI가 게임 화면을 직접 관찰하고 제한된 입력으로 콘텐츠를 탐사한 뒤, 별도의 AI가 그 증거를 위키로 구조화하고, 신뢰된 평가기가 문서의 재현성과 전이성을 검증하는 **로컬 MVP 구현과 설계 명세**입니다.

목표는 “게임을 잘하는 AI”가 아니라 다음 능력을 분리해서 측정하는 것입니다.

1. 연속 화면에서 콘텐츠 단서를 발견하고 필요한 상호작용을 수행하는가
2. 관찰한 사실을 조건·관계·절차로 구조화할 수 있는가
3. 다른 새 에이전트가 그 문서만 보고 같은 콘텐츠를 재현할 수 있는가
4. 배치와 표현이 바뀌어도 문서의 의미가 전이되는가

모든 실행은 로컬에서 이루어집니다. 게임 화면, 플레이 기록, 위키 후보, 비공개 seed와 평가 결과를 외부 서비스에 업로드하지 않는 것을 기본 정책으로 삼습니다.

## 문서 구성

- [로컬 실행 런북](RUNBOOK.md): 검증 명령, 실제 Windows 창 연결, 산출물 위치와 현재 한계
- [공용 프로토콜](packages/atlas_protocol/CONTRACT.md): 모듈 사이의 공개·비공개 계약과 artifact chain
- [01 Player Runner](01_player_runner/DESIGN.md): 화면 캡처, 제한 입력, 좌표 추상화, 감사 기록
- [02 Wiki Foundry](02_wiki_foundry/DESIGN.md): 증거에서 지식 그래프와 결정론적 위키를 생성
- [03 Replay Judge](03_replay_judge/DESIGN.md): 실제 엔진 재생, 전이 실험, 채점과 누출 탐지
- [04 Desktop Bridge](04_desktop_bridge/DESIGN.md): URL·CDP 없이 선택 창 픽셀 캡처와 제한 OS 입력
- [Desktop Bridge 계약](04_desktop_bridge/CONTRACT.md): 공통 target gate, stable capture/input provider, 무 fallback·무 재시도 규칙
- [Desktop Bridge 에이전트 배정](04_desktop_bridge/AGENT_ASSIGNMENTS.md): 모듈별 소유 경로와 독립 검증 결과
- [블라인드 개발 운영](BLIND_DEVELOPMENT.md): 모듈 개발 에이전트의 지식과 파일 권한을 격리
- [서브에이전트 회의 기록](MEETING_NOTES.md): 독립 설계와 적대적 교차검토에서 합의한 결정

## 현재 구현 상태

| 영역 | MVP 상태 | 구현 내용 |
|---|---|---|
| Atlas Protocol | 완료 | 결정론적 canonical JSON, SHA-256, Ed25519 서명, 공용 스키마, 금지 데이터 검사 |
| Player Runner | 완료 | 프레임 관찰, 허용 키 입력, opaque option, capability, WAL, receipt chain, 봉인 저장, MCP 호환 stdio |
| Wiki Foundry | 완료 | 봉인 handoff 검증, 증거 저장소, 사실·절차·모순·미확인 구조화, 결정론적 Markdown/AST, 서명 |
| Replay Judge | 완료 | 문서 검증, 비공개 probe, fresh-state 이중 재생, strict/assisted 분리, 전이 비교와 누출 검사 |
| Desktop Bridge | 완료 | 운영자 전용 target 선택, trusted bootstrap에 고정된 독립 capture/input provider, GDI+SendInput 기본, 무 fallback, 좌표 비노출 |
| Quest Atlas 통합 | 완료 | 실제 게임 reducer source/transfer 검증; CDP adapter는 레거시 개발 참고용 |
| 종단 연결 | 완료 | Runner → Foundry → Judge 서명 체인과 증거 폐쇄성 검증 |

```powershell
cd D:\git\test_game\agent_tools
test.cmd all
```

`test.cmd`는 PATH의 Node.js를 먼저 찾고, 없으면 Codex 데스크톱에 포함된 Node.js를 자동으로 사용하므로 `npm`이 없어도 됩니다. 위 명령은 외부 API를 호출하지 않으며 모델 사용료를 발생시키지 않습니다. 실제 AI 플레이는 이 로컬 Runner를 AI/MCP 클라이언트에 연결했을 때 시작됩니다.

## 전체 흐름

```text
Trusted Target Picker
        │ private target binding
        ▼
04 Desktop Bridge
        │ PNG + bounded input
        ▼
Trusted Config Broker
        │ private configHandle
        ▼
01 Player Runner ── PublicPlayHandoff ──▶ 02 Wiki Foundry
        │                                      │
        │ PrivateJudgeEnvelope                 │ KnowledgeSubmission
        │                                      ▼
        └──────────────────────────────▶ 03 Replay Judge
                                               │
                         Normalized Wiki ───────┤
                                               ▼
                          fresh Reproduction / Transfer Agent
                                               │
                                      signed ActionTranscript
                                               ▼
                                     actual engine replay × 2
                                               │
                                               ▼
                                         ScoreReport
```

Player, Wiki, Reproduction 에이전트는 매 단계마다 새 프로세스·새 작업공간·새 target binding을 사용합니다. 대화 메모, 클립보드, 애플리케이션 저장소, 네트워크 캐시를 공유하지 않습니다. 기본 화면 경로는 운영자가 선택한 Windows 창의 합성 픽셀이며 URL이나 CDP를 사용하지 않습니다. Desktop capture/input provider 역시 운영자가 세션 시작 전에 고정합니다. 변경 시 기존 lifecycle을 닫고 새 target binding·launch·policy attestation을 만들며 실행 중 자동 fallback은 허용하지 않습니다.

## 신뢰 경계

| 역할 | 신뢰 여부 | 알 수 있는 것 | 알 수 없는 것 |
|---|---|---|---|
| Player Agent | 비신뢰 | 제공된 화면, 허용 행동, 자신의 공개 receipt | seed, DOM, 좌표, 정답, 점수 |
| Wiki Agent | 비신뢰 | 봉인된 공개 증거, 공개 ontology | 게임 실행환경, seed, 정답, 점수 |
| Reproduction Agent | 비신뢰 | 정규화된 Wiki와 새 화면 | 탐사 대화/행동 기록, source seed, probe |
| Runner | 제한 신뢰 | 캡처와 입력 전달, opaque config handle | config의 의미, canonical truth |
| Foundry | 제한 신뢰 | 공개 handoff와 파생 지식 | private transcript, seed, Judge 결과 |
| Judge | 신뢰 | opaque handle, signed outcome, 채점 응답 | raw seed, production key |
| Engine Runner | 신뢰 | one-time ReplayAuthorization, pinned build, probe 실행물 | registry mapping, truth weight, production key |
| Fixture Custodian | 신뢰 | seed, truth, target set | 모델 runtime, action transcript, production key |
| Key Service | 신뢰 | issuer policy를 통과한 artifact digest | payload, truth, 모델 runtime |

## 평가 트랙

- `strict`: 자유형 Explorer 메모 없이 프레임·관찰 번호·제한 action receipt만 전달합니다. 공식 점수는 이 트랙을 기준으로 합니다.
- `assisted`: 제한된 가설 카드나 재조사 요청을 허용합니다. strict 점수와 합치지 않습니다.
- `keyboard`: 허용 키의 press/tap만 사용합니다. 현재 02 게임에 적용하기 적합합니다.
- `object-action`: 화면 위의 매 프레임 일회성 opaque option을 활성화합니다. AI가 좌표를 제출하지 않습니다.
- `raw-coordinate`: 순수 시각 운동 능력을 별도로 평가할 때만 사용합니다. 콘텐츠 이해 점수와 섞지 않습니다.

## 구현 순서

1. `atlas_protocol`의 JSON Schema, canonicalization, 서명 test vector를 먼저 고정합니다.
2. Runner를 synthetic Canvas와 fake input sink로 구현합니다.
3. Foundry를 synthetic public handoff로 구현합니다.
4. Judge를 synthetic truth와 fake replay engine으로 구현합니다.
5. 신뢰된 통합 담당자가 Desktop Bridge와 실제 게임의 trusted replay adapter를 붙입니다.
6. private holdout에서 baseline/candidate/oracle 실험을 실행합니다.

각 모듈 개발자는 이 인덱스 전체를 받지 않습니다. 실제 개발 배정은 [블라인드 개발 운영](BLIND_DEVELOPMENT.md)의 역할별 Contract Pack만 전달해야 합니다.
