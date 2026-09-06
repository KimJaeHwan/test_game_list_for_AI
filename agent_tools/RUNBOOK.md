# Atlas Agent Tools 로컬 실행 런북

## 1. 무엇이 실행되는가

구현은 서로 다른 책임을 가진 일곱 영역으로 나뉩니다.

1. **Desktop Bridge**는 운영자가 선택한 Windows 창과 세션 시작 전에 고정한 capture/input provider를 통해 합성 화면 PNG와 제한 OS 입력을 제공합니다.
2. **Player Runner**는 그 프레임과 허용된 행동만 AI에게 제공하고 증거를 봉인합니다.
3. **Wiki Foundry**는 봉인된 프레임·행동 증거만 읽고 사실, 관계, 절차, 모순, 미확인을 위키 문서로 정규화합니다.
4. **Replay Judge**는 새 상태와 변형된 화면에서 문서의 절차를 다시 실행하고 성공 여부와 누출을 판정합니다.
5. **Vision Agent Host**는 Codex/GPT에 PNG 한 장씩 제공하고 구조화된 행동 하나만 받아 Runner capability를 대신 적용합니다.
6. **Assisted Wiki Loop**는 봉인된 실행의 모든 검증 화면을 최대 12장씩 여러 fresh Wiki Agent에 제공하고, 전 batch를 한 Wiki revision으로 원자적으로 병합합니다.
7. **Checkpoint Campaign**은 선제 checkpoint로 봉인된 episode를 Wiki에 게시하고 ACK와 digest를 검증한 뒤, topic/episode shard에서 관련 top-K 지식만 골라 다음 fresh Player 세션을 시작합니다.

좌표는 신뢰 경계 밖으로 나오지 않습니다. AI가 받는 것은 허용 키 코드 또는 프레임에 묶인 일회성 `optionRef`이며, 실제 좌표 변환은 Runner 내부 adapter만 수행합니다. URL, DOM, CDP, accessibility tree, 프로세스 메모리는 기본 Desktop Bridge 경로에서 사용하지 않습니다. 현재 범용 연결에는 visual target detector가 없으므로 object option 목록은 비어 있습니다.

## 2. 사전 조건

- Node.js 22.13 이상
- .NET 9 SDK와 Windows Desktop Runtime
- `03_quest_atlas` 의존성 설치 완료
- Windows 10 이상
- 실제 AI 플레이에만 Codex CLI와 ChatGPT 로그인이 추가로 필요

모든 기본 검증은 로컬 파일·fake 모델·로컬 게임만 사용합니다. OpenAI API, ChatGPT 업로드, 외부 저장소 업로드는 자동으로 수행하지 않습니다. 실제 Vision Player는 화면을 OpenAI에 보내므로 사내 화면에는 회사의 데이터 전송 승인이 필요합니다.

## 3. 전체 자동 검증

현재 Codex 로컬 환경에는 `npm`이 PATH에 없을 수 있습니다. 이 저장소의 Windows용 test runner는 Codex에 포함된 Node.js를 자동으로 찾아 사용합니다.

```bat
cd D:\git\test_game\agent_tools
test.cmd all
```

개별 검증은 다음 순서로 하나씩 실행할 수 있습니다.

```bat
test.cmd protocol
test.cmd runner-core
test.cmd runner-service
test.cmd foundry
test.cmd judge
test.cmd game
test.cmd browser
test.cmd pipeline
test.cmd desktop-native
test.cmd desktop-target
test.cmd desktop-input
test.cmd desktop
test.cmd desktop-runner
test.cmd desktop-boundaries
test.cmd vision-host
test.cmd vision-integration
test.cmd wiki-core
test.cmd wiki-model
test.cmd wiki-loop
test.cmd checkpoint-campaign
test.cmd boundaries
```

사용 가능한 이름과 설명은 `test.cmd list`로 확인합니다. `live-window`는 사용자가 실제 대상 창을 고르고 foreground로 전환해야 하므로 자동 전체 테스트에는 포함되지 않습니다.

전체 suite는 공용 서명 계약, Runner의 exact-once 입력과 파일 봉인, Foundry의 증거 폐쇄성, Judge의 fresh replay, 실제 Quest Atlas reducer, Desktop Bridge 네이티브 빌드와 정책, Vision Host의 fake Codex/실제 Runner stdio 흐름, Assisted Wiki의 다중 batch 원자 게시, checkpoint ACK·누적 예산·episode shard·관련 context·fresh-session 재개, Contract Pack 경계를 검사합니다.

## 4. 실제 Windows 창 `live-window` smoke test

이 테스트는 Chrome 전용 기능을 사용하지 않습니다. Quest Atlas를 일반 Chrome 창으로 열어도 되고, 다른 일반 프로그램 창을 선택해도 됩니다.

Quest Atlas 서버가 아직 실행되지 않았다면 터미널 A에서 실행합니다.

```bat
cd /d D:\git\test_game\03_quest_atlas
"C:\Users\김재환\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" node_modules\vite\bin\vite.js --host 127.0.0.1 --port 3001
```

일반 브라우저에서 `http://127.0.0.1:3001/`을 엽니다. 원격 디버깅 옵션이나 별도 Chrome profile은 필요하지 않습니다.

터미널 B에서 native bridge를 빌드하고 운영자가 선택할 수 있는 창 목록을 표시합니다.

```bat
cd /d D:\git\test_game\agent_tools
test.cmd desktop-native
test.cmd windows
```

목록에서 대상 창의 `HWND` 숫자를 찾습니다. 이 값과 함께 표시되는 title, process 정보는 운영자 전용이며 AI 프롬프트나 공개 산출물에 넣지 않습니다.

같은 터미널에서 선택한 숫자를 환경 변수에 넣고 테스트합니다. 아래 `123456`은 실제 출력값으로 교체합니다.

```bat
set ATLAS_TARGET_HWND=123456
set ATLAS_CAPTURE_REGION=
set ATLAS_ARM_DELAY_MS=5000
test.cmd live-window
```

`Focus the selected target window now`가 표시되면 5초 안에 대상 게임 창을 클릭합니다. 테스트 중에는 그 창을 foreground로 유지하고 다른 창으로 가리지 않습니다. 테스트는 화면을 캡처하고 기본값 `Enter`를 실제로 한 번 전달한 뒤 다시 캡처합니다. 입력을 받아도 안전한 승인된 QA 창/계정에서만 실행하십시오. 다른 허용 키가 필요하면 실행 전에 `ATLAS_SMOKE_KEY`를 fixed allowlist의 값으로 설정합니다.

필요한 경우 `ATLAS_CAPTURE_REGION=x,y,width,height`로 선택 창의 client 영역 중 일부만 고정할 수 있습니다. 이 값은 운영자가 정하며 AI는 알 수 없습니다. 처음에는 빈 값으로 전체 client 영역을 테스트하는 것이 쉽습니다.

성공 결과는 다음 의미입니다.

| 결과 | 의미 |
|---|---|
| `liveWindow: passed` | 선택한 일반 Windows 창의 실제 연결 성공 |
| `frame: ... composited GUI pixels` | 현재 화면에 보이는 선택 영역을 PNG로 캡처 |
| `keyTap: ... bounded SendInput` | identity·foreground 검사 후 허용 키 한 번 전달 |
| `visibleFrameChanged: true` | 입력 전후 픽셀이 달라져 대상 화면이 반응함 |
| `browserProtocolUsed: false` | CDP, DOM, URL 기반 제어를 사용하지 않음 |
| `targetMetadataExposedToCaller: false` | HWND, PID, 실행 파일, region이 AI-facing 결과에 없음 |
| `absoluteCoordinatesExposedToCaller: false` | 데스크톱 절대좌표가 AI-facing 결과에 없음 |

`keyTap`의 `bounded SendInput` 문구는 현재 기본 provider/backend 조립을 확인하는 문구입니다. `DELIVERED`인데 `visibleFrameChanged`가 false이면 스크립트는 실패합니다. 이는 입력이 없었다는 증명이 아니라 선택한 키 뒤 200ms 시점의 캡처 digest가 같다는 뜻이므로 자동 재시도하지 말고 창/키/화면 반응을 운영자가 확인합니다. foreground 상실, 가림, identity/geometry 변경은 의도된 fail-closed 결과이며 먼저 창을 복원한 뒤 새로 선택·bind하여 새 실행을 시작합니다. `DELIVERY_UNKNOWN` 또한 입력이 일부 전달됐을 수 있으므로 같은 실행에서 재시도하지 않습니다.

이 테스트는 실제 AI의 콘텐츠 이해나 Wiki 생성을 검사하지 않습니다. AI가 사용할 범용 `GUI 픽셀 관찰 → 제한 OS 입력 → GUI 픽셀 재관찰` 통로만 검사합니다. `test.cmd all`에는 포함되지 않으며 운영자가 명시적으로 실행할 때만 실제 OS 입력이 발생합니다.

## 5. AI/MCP 클라이언트에 Player Runner 연결

stdio 서버 진입점은 `01_player_runner/src/stdio-server.mjs`, 범용 Windows bootstrap은 `04_desktop_bridge/integration/local-runner-bootstrap.mjs`입니다. 먼저 `test.cmd windows`에서 운영자가 선택한 HWND를 확인한 뒤 서버 프로세스에 다음 환경을 제공합니다.

```text
ATLAS_RUNNER_BOOTSTRAP=D:\git\test_game\agent_tools\04_desktop_bridge\integration\local-runner-bootstrap.mjs
ATLAS_LAUNCH_TICKET=<운영자가 생성한 일회성 임의 문자열>
ATLAS_TARGET_HWND=<운영자가 선택한 숫자>
ATLAS_CAPTURE_REGION=<선택: x,y,width,height>
ATLAS_ALLOWED_KEYS=<선택: Enter,ArrowUp처럼 쉼표 구분>
ATLAS_RUNNER_STATE_DIR=<선택: 절대 경로>
ATLAS_DESKTOP_BRIDGE_EXE=<선택: native exe 절대 경로>
```

실행 명령은 다음과 같습니다.

```bat
"C:\Users\김재환\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" D:\git\test_game\agent_tools\01_player_runner\src\stdio-server.mjs
```

실제 `observe`와 입력 호출 시 선택 창은 foreground이고 가려지지 않은 상태여야 합니다. Runner는 창을 대신 활성화하지 않으며 identity나 크기가 바뀌면 운영자 재선택을 요구합니다.

현재 bootstrap의 trusted composition은 capture에 `gdi-composited-screen/v1`, input에 `SendInputBackend`/`win-sendinput`을 사용합니다. 공개 runtime provider 선택 환경 변수는 없고 이 기본값은 trusted composition/native code에 고정되어 있습니다. 이 선택은 AI-facing 환경이나 도구 argument로 받지 않습니다. capture와 input provider는 독립 주입되지만 세션 동안 고정되며 실패 시 서로 또는 다른 구현으로 fallback하지 않습니다. 세션 종료 시 provider lifecycle이 공유 native resource를 한 번만 닫습니다.

클라이언트에 노출되는 도구는 정확히 다음 여덟 개입니다.

| 도구 | 역할 |
|---|---|
| `attach_run` | 일회성 launch ticket으로 로컬 세션 연결 |
| `observe` | 현재 PNG 프레임과 opaque option 관찰 |
| `tap_key` | 허용 목록의 키를 현재 프레임에 결박하여 tap |
| `activate_option` | 현재 프레임의 일회성 `optionRef` 활성화 |
| `wait_frame` | 다음 프레임 대기 |
| `bookmark_observation` | 이미 제공된 공개 증거만 북마크 |
| `request_end` | 실행 종료 요청 |
| `seal_handoff` | 공개 handoff와 비공개 Judge envelope 봉인 |

`x`, `y`, selector, DOM, URL, 임의 click·navigate 요청은 argument allowlist에서 거부됩니다. 입력 결과가 불명확하면 자동 재시도하지 않아 이중 입력을 막습니다.

## 6. Provider 교체 운영 절차

GDI 또는 SendInput이 맞지 않는 승인된 QA 환경에서는 Windows.Graphics.Capture, DXGI, 다른 입력 API를 stable provider/backend seam 뒤에 추가할 수 있습니다. 운영자는 다음 체크리스트를 모두 충족한 뒤에만 기본 조립을 바꿉니다.

1. JS capture는 exact `{providerId,capture}`, input은 `dispatch(action,pinnedTarget)` 계약을 구현하고 기존 Runner API는 바꾸지 않습니다.
2. native primitive가 필요하면 각각 `IFrameCaptureBackend` 또는 `IInputBackend`를 구현합니다. backend는 common target/state guard가 검증한 값만 받고 창 inspect/focus/retarget을 하지 않습니다.
3. capture 결과는 exact PNG/width/height/provider ID를, input 결과는 `DELIVERED`/`NOT_DELIVERED`/`DELIVERY_UNKNOWN`과 nonsemantic receipt를 반환합니다. target/좌표/native 오류 상세를 공개 결과에 넣지 않습니다.
4. JS `TargetBindingBroker.withPrivateBinding`과 native identity/geometry/foreground/visibility/occlusion 또는 hit-test 검증을 모두 유지합니다. 어느 한쪽을 새 API의 보장으로 대체하지 않습니다.
5. 요청당 primitive 호출은 최대 한 번입니다. 실패나 ambiguity 뒤 재시도, 같은 세션/요청에서 다른 provider로 자동 fallback, 창 자동 focus를 금지합니다.
6. provider/backend 선택은 trusted bootstrap 또는 operator config에만 둡니다. Runner action, public MCP argument, native NDJSON 요청으로 선택하지 않습니다.
7. 기존 세션을 정상 종료하고 lifecycle을 close한 뒤 운영자가 창을 재선택·bind하고 새 launch ticket과 새 세션을 만듭니다. hot swap하지 않습니다.
8. 새 capture `providerId`로 `capturePolicyDigest`가 달라지는지 확인합니다. input 의미가 달라지면 `DESKTOP_INPUT_POLICY_VERSION`을 올리고 새 세션에 다른 policy attestation을 기록합니다.
9. fake provider/backend에서 invalid result, throw, not-delivered, ambiguity, 최대 1회 호출, zero dispatch를 검사하고 `desktop-native`, `desktop-target`, `desktop-input`, `desktop`, `desktop-runner`, `desktop-boundaries`를 통과시킵니다.
10. 승인된 전용 창에서만 `live-window`를 수동 실행해 실제 캡처·입력·종료를 확인합니다. 이 단계에 자동 fallback을 추가하지 않습니다.

## 7. 산출물과 개인정보 경계

기본 상태 디렉터리는 `agent_tools/.local`이며 Git에서 제외됩니다.

- `runs-public`: Foundry에 전달 가능한 PNG, 관찰, 행동, manifest
- `judge-vault`: seed/config handle, 비공개 receipt와 Judge용 envelope
- `coordinator/<publicRunId>`: 실행 메타데이터, 공개키, 입력 WAL
- `assisted-wiki/<campaign>/revisions/rNNNNNN`: 누적 snapshot, Markdown Wiki, 다음 Player context, Wiki 모델 사용량
- Checkpoint Campaign의 지정 디렉터리 아래 `episodes/eNNNNNN/revisions/r000001`: segment별 물리 Wiki와 ACK
- 같은 디렉터리의 `routing/rNNNNNN`: topic/episode shard manifest, shard 문서, 다음 Player용 `selected-context.json`

공개 산출물의 모든 파일은 manifest의 SHA-256과 크기로 1:1 검증됩니다. 공개·비공개 루트 중첩, 덮어쓰기, 경로 이탈은 실패 처리됩니다.

## 8. 현재 MVP의 경계

- Codex CLI 기반 VLM 프롬프트 orchestration은 구현했지만 자동 테스트는 fake model만 사용합니다. 실제 호출은 `--confirm-openai-upload` 없이는 시작되지 않습니다.
- STRICT Foundry는 현재 라이브러리와 검증 파이프라인이며 별도 편집 UI는 없습니다. 반복 탐사용 ASSISTED Wiki에는 `wiki-builder.cmd`가 있습니다.
- 로컬 bootstrap은 실행마다 임시 Ed25519 키를 만듭니다. 운영 배포에는 지속 Key Service와 키 보관 정책이 필요합니다.
- 범용 Desktop Bridge의 안전 click primitive와 object-action resolver는 구현했지만, 화면에서 클릭 후보를 생성하는 visual target detector는 아직 연결하지 않았습니다. 현재 공개 option 목록은 비어 있습니다.
- v1 기본 `IFrameCaptureBackend`는 foreground의 현재 합성 픽셀을 GDI로 복사합니다. 일부 보호 surface, exclusive fullscreen, 특정 DirectX 게임이 검은 화면을 반환하면 6절 절차로 WGC/DXGI backend를 도입해야 하며 런타임 자동 fallback은 하지 않습니다.
- v1 기본 `IInputBackend`는 `SendInput`입니다. 안티치트나 무결성 수준에 따라 거부될 수 있으므로 승인된 QA 클라이언트·계정·환경에서만 사용하며 다른 입력 API로 자동 우회하지 않습니다.
- Contract Pack exporter와 경계 검사는 구현했지만 이 환경에서는 Docker daemon을 사용할 수 없어 개발 프로세스의 OS 수준 파일 격리는 실행 검증하지 못했습니다.
- 실제 AI를 사용한 blind baseline/candidate/oracle 캠페인은 아직 실행하지 않았습니다. Judge는 그 실험을 받을 계약과 재생 경로까지 제공합니다.

이 상태는 **로컬 scripted E2E, 범용 Windows 창 연결, Codex Player/Wiki와 checkpoint campaign 실행 경로까지 구현한 개발 MVP**입니다. 실제 선택 창의 capture/input은 4절의 `live-window`를 운영자가 foreground 전환과 함께 확인합니다. 이후 13절의 작은 실제 campaign을 승인된 QA 창에서 확인한 뒤, 동일한 holdout을 여러 모델에 반복해 탐사·위키·재현 점수를 수집해야 합니다.

## 9. 레거시 CDP adapter

`integration/quest_atlas/browser-adapter.mjs`와 `test.cmd live-browser`는 웹 개발 중 Canvas adapter를 비교·회귀 검사하기 위해 남겨 둡니다. 기본 Player Runner 연결에는 사용하지 않으며, 메이플스토리형 GUI 평가의 근거로 해석하지 않습니다.

## 10. Codex/GPT로 실제 화면 플레이

먼저 외부 전송이 없는 오프라인 검증을 실행합니다.

```bat
cd /d D:\git\test_game\agent_tools
test.cmd vision-host
test.cmd vision-integration
```

`vision-host`는 Codex process를 흉내 낸 fake spawn과 fake Runner로 schema·timeout·금지 tool event를 검사합니다. `vision-integration`은 fake model과 실제 Player Runner stdio child를 연결해 `attach → observe → Enter → wait_frame → end → seal`을 검사합니다. 둘 다 OpenAI에 이미지를 보내지 않고 실제 OS 키도 누르지 않습니다.

실제 플레이 전에는 게임을 켜고 대상 창을 선택합니다.

```bat
test.cmd desktop-native
test.cmd windows
set ATLAS_TARGET_HWND=123456
set ATLAS_ALLOWED_KEYS=ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Enter,Tab,Space,Shift,KeyB,KeyC,KeyF
```

`123456`은 `test.cmd windows`가 표시한 승인된 게임 창의 실제 HWND로 바꿉니다. 키 목록도 해당 테스트 게임에 필요한 최소 집합으로 줄이는 것이 좋습니다.

다음 명령은 모델에 제공하는 모든 화면 PNG를 OpenAI로 전송할 수 있다는 운영자 확인을 포함합니다.

```bat
vision-player.cmd --confirm-openai-upload
```

첫 실제 smoke test에서는 모델 호출과 입력을 작게 제한하는 편이 좋습니다.

```bat
set ATLAS_VISION_MAX_TURNS=5
set ATLAS_VISION_MAX_KEYS=3
set ATLAS_VISION_MAX_OBSERVATIONS=8
set ATLAS_VISION_MAX_ELAPSED_MS=300000
set ATLAS_VISION_MODEL_RESTARTS=0
set ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS=55000
vision-player.cmd --confirm-openai-upload
```

각 값은 기본 안전 상한보다 작게만 지정할 수 있습니다. 지정하지 않으면 계약의 기본 예산을 사용합니다. `ATLAS_VISION_MODEL_RESTARTS`만 `0` 또는 `1`이며 기본값은 `1`입니다. 첫 smoke test에서 `0`으로 두면 실패 후 모델 session 자동 재시작을 끌 수 있습니다. `ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS`는 마지막 성공 turn의 input token delta가 지정값 이상일 때 다음 판단 전에 fresh Codex session으로 선제 전환합니다. 기본값은 `55000`, `0`은 비활성화이고 1~55000 범위로만 낮출 수 있습니다.

같은 창에서 55,000 input-token rollover를 두 번 검증하는 장시간 실행은 명시적 `--long-run` profile로만 시작합니다. 이전 smoke test의 네 수동 상한이 남아 있으면 먼저 비웁니다.

```bat
set ATLAS_VISION_MAX_TURNS=
set ATLAS_VISION_MAX_KEYS=
set ATLAS_VISION_MAX_OBSERVATIONS=
set ATLAS_VISION_MAX_ELAPSED_MS=
set ATLAS_VISION_MODEL_SESSION_INPUT_TOKENS=55000
vision-player.cmd --confirm-openai-upload --long-run
```

`--long-run`은 내부 `ROLLOVER_ENDURANCE_2X` profile을 선택하며 Host 상한을 120 turns, 60 keys, 180 observations, 2,700,000ms로 고정합니다. 위 네 `ATLAS_VISION_MAX_*` 환경 변수 중 하나라도 함께 지정하면 실행 준비 단계에서 거부합니다. rollover threshold는 미지정 또는 정확히 `55000`만 허용하며 `0`이나 더 낮은 값은 두 번의 55K 검증 목표와 양립하지 않으므로 거부합니다. 모델 restart는 `ATLAS_VISION_MODEL_RESTARTS=0`처럼 더 작게 제한할 수 있습니다.

Runner에도 Host가 신뢰한 동일 profile만 전달되며 capability 예산은 observe 180, keyboard 60, bookmark 180, object 50, handoff 2, TTL 3,000,000ms로 고정됩니다. 사용자가 `ATLAS_RUNNER_PROFILE`을 직접 설정해 profile을 바꿀 수는 없습니다. 기본 명령에는 이 profile이나 확대 예산이 적용되지 않습니다.

장시간 결과에는 `executionProfile: ROLLOVER_ENDURANCE_2X`, `primaryScoreEligible: false`와 `rolloverEndurance`가 추가됩니다. `rolloverEndurance.status: PASS`는 같은 실행에서 검증된 rollover가 목표 2회를 충족했다는 뜻입니다. 정상 봉인됐더라도 실행이 너무 일찍 끝나 두 번을 채우지 못하면 `INSUFFICIENT_DURATION`이며 실패를 성공으로 과장하지 않고 일반 주 점수에도 포함하지 않습니다.

명령을 실행하면 기본 5초 동안 대기합니다. 그 사이 대상 게임 창을 클릭해 foreground로 유지하고 다른 창으로 가리지 마세요. 대기 시간은 `ATLAS_VISION_ARM_DELAY_MS=10000`처럼 0~30000ms 범위에서 바꿀 수 있습니다.

확인 플래그가 없으면 `REMOTE_UPLOAD_NOT_CONFIRMED`로 종료되며 캡처와 모델 호출이 발생하지 않습니다. 실행 중 모델은 좌표·HWND·URL·Runner capability를 받지 않고, 현재 PNG·허용 키·coarse 예산·직전 공개 결과만 받습니다. 한 turn에는 행동 하나만 가능하고, 전달 결과가 불명확하면 추가 키 입력 없이 partial 종료합니다.

산출물은 기본적으로 `agent_tools/.local/vision-agent/<hostRunId>/`에 남습니다.

- `host/frames`: 모델에 실제 제공한 모든 PNG
- `host/model`: 동적 JSON Schema와 turn별 최종 행동
- `host/driver.jsonl`: capability가 제거된 감독 기록
- `host/usage.json`: 모델 token 집계의 완전성과 알려진 합계, 비용 미제공 상태
- `runner/runs-public`: Wiki Foundry에 전달할 공개 handoff
- `runner/judge-vault`: 로컬 비공개 평가 envelope

`host/model/action.schema.json`은 Supervisor 내부 행동 계약입니다. 성공한 모델 turn의 `decision-N.json`은 root `action` 아래 exact 행동 객체가 있는 OpenAI 호환 nested wire envelope를 담습니다. turn마다 만들어지는 `decision-N.json.provider-schema.json`은 Codex 종료 뒤 제거되므로 남지 않는 것이 정상입니다. 첫 turn이 실패하면 `decision-1.json` 자체가 없을 수 있습니다.

정확한 `MODEL_TURN_FAILED`가 발생하면 Host는 기본적으로 같은 verified frame과 불변 입력 상태를 재검사한 뒤 새 Codex session에서 최대 한 번 다시 판단합니다. 실패와 재판단은 각각 모델 turn을 소비하지만 화면 관찰과 키 입력은 재시작 자체로 늘지 않습니다. journal에는 비밀 없는 `model_restart_authorized`와 `model_session_reset`이 순서대로 남습니다. 두 번째 실패, 남은 예산 부족 또는 재시작 비활성화는 기존 recoverable PARTIAL 봉인으로 끝나고, frame·journal·reset receipt 이상이나 다른 모델 오류는 추가 호출 없이 격리됩니다.

실패가 발생하기 전에도 마지막 성공 turn의 `inputTokens`가 기본 55,000 이상이면 Host는 다음 판단 직전에 같은 verified frame을 고정한 채 session을 선제 전환합니다. journal에는 `model_rollover_authorized` 다음 `model_session_rotated`가 남고, 이어지는 `frame_served`는 승인 기록과 같은 frameId/hash여야 합니다. rollover는 turn·키·관찰 횟수를 늘리지 않습니다. rotation API 부재, malformed receipt, 비정상 journal, frame/hash/state 변화가 있으면 새 모델 호출이나 추가 키 입력 없이 `MODEL_SESSION_ROTATION_FAILED` 또는 해당 무결성 stop code로 격리됩니다.

`model_turn_failed`에 `codexErrorInfo`가 있으면 Host가 원시 CLI 오류에서 허용한 `category`, `httpStatus`, `retryable`만 새 객체로 투영한 진단입니다. 원시 메시지·본문·request/thread ID·stderr는 저장하지 않습니다. `retryable: true`여도 모델 restart 예산은 1회를 넘지 않고, 다른 오류를 restart 대상으로 바꾸지 않습니다. 필드가 없는 과거 journal은 기존 의미 그대로 해석합니다.

종료 결과에서 `SEALED`는 handoff 기록이 정상 봉인됐다는 뜻입니다. 모델이 스스로 `PARTIAL`을 선택한 정상 종료에는 `stopCode`가 없습니다. 새 Vision Host에서 모델이 화면 판단 중 `MODEL_TURN_FAILED`를 반환했더라도, 실패한 turn에 행동이 생성되지 않았고 이전 입력의 결과 프레임이 모두 정산됐으며 모델 프로세스 종료와 journal·`request_end`·`seal_handoff`가 확인되면 내부적으로 `RECOVERABLE_PARTIAL → ENDING → SEALING → SEALED` 순서로 종료합니다. 이때 CLI 결과는 `status: SEALED`, `reason: PARTIAL`, `stopCode: MODEL_TURN_FAILED`를 유지합니다. 이는 콘텐츠를 완료했다는 뜻이 아니라, 실패 전까지의 화면 증거를 안전하게 봉인했다는 뜻입니다.

그 밖의 모델 프로세스·schema·금지 tool event·입력 결과 불명확·journal 오류는 계속 `QUARANTINED`입니다. 일반 `QUARANTINED` 실행은 Wiki evidence로 자동 수용되지 않습니다. `failures`는 `request_end`/`seal_handoff` 실패 횟수이므로 `failures: 0`만으로 모델 판단 성공이나 Wiki 수용 가능성을 뜻하지 않습니다. 결과는 `status`, `reason`, `stopCode`, `host/model/decision-N.json`, `host/driver.jsonl`을 함께 봅니다.

같은 종료 JSON의 `usage`와 `host/usage.json`에는 Codex CLI가 각 모델 호출에서 보고한 token 사용량이 기록됩니다. `inputTokens`에는 cached input이 이미 포함되므로 `totalTokens`는 `inputTokens + outputTokens`이며 cached 값을 다시 더하지 않습니다. `completeness`가 `PARTIAL`이면 알려진 합계는 일부 호출만 포함한 하한이고, `UNKNOWN`이면 `knownTotals`가 `null`입니다. 사용량이 누락된 호출을 0으로 해석하면 안 됩니다.

`monetaryCost.status: UNAVAILABLE`은 실행 비용이 0이라는 뜻이 아닙니다. 현재 CLI 결과만으로 실제 청구 금액과 통화를 확정할 수 없어 `actualChargedAmount`, `estimatedAmount`, `currency`를 `null`로 남긴 것입니다. 모델과 시점별 rate card를 운영자가 명시적으로 고정하는 별도 estimator를 추가하기 전에는 이 값을 달러 비용으로 환산하지 않습니다.

이 v1은 수 초 단위의 화면 판단에 적합합니다. 서브초 반응이 필요한 실시간 전투나 연속 영상 이해는 아직 대상이 아니며, 다음 버전에서 keyframe/filmstrip 관찰로 분리해야 합니다.

## 11. 봉인된 플레이를 Wiki로 만들기

먼저 외부 업로드 없이 새 경계를 검사합니다.

```bat
cd /d D:\git\test_game\agent_tools
test.cmd wiki-core
test.cmd wiki-model
test.cmd wiki-loop
```

`wiki-core`는 병합·중복 제거·대체 사례·문서 결정성을, `wiki-model`은 가짜 Codex process로 strict output schema와 도구 차단을, `wiki-loop`는 가짜 모델과 실제 Runner stdio로 15프레임 플레이부터 2개의 Wiki revision 및 다음 Player context까지 검사합니다. 이 세 명령은 OpenAI 업로드, 실제 모델 호출, 실제 OS 입력을 하지 않습니다.

실제 플레이가 끝나면 종료 JSON의 `outputDirectory`를 복사합니다. 예를 들어 다음과 같은 형식입니다.

```text
D:\git\test_game\agent_tools\.local\vision-agent\<hostRunId>
```

그 경로를 `--run`에 넣어 Wiki Builder를 실행합니다.

```bat
wiki-builder.cmd --confirm-openai-upload --run "D:\git\test_game\agent_tools\.local\vision-agent\<hostRunId>"
```

이 명령은 창에 입력을 보내지 않습니다. Host 종료 상태와 Runner 서명·manifest hash·Host seal digest를 검증한 뒤 source의 모든 signed screenshot 복사본을 ordinal 순서로 최대 12장씩 나눠 batch마다 fresh Codex Wiki Agent에 업로드합니다. **12장은 전체 실행 한도가 아니라 모델 호출 한 번의 이미지 상한**입니다. 예를 들어 65 frame source는 12/12/12/12/12/5의 6회 모델 호출을 사용합니다.

따라서 플레이 때의 모델 호출과 별개로 `--confirm-openai-upload`가 다시 필요하며, Wiki 모델 token·시간 소비는 batch 수에 비례해 늘 수 있습니다. source/snapshot 사전검증은 첫 호출 전에 수행되고, 모든 batch proposal이 성공·검증돼야 revision 하나를 게시합니다. 중간 batch가 실패하면 해당 실행은 새 snapshot/context/revision을 남기지 않습니다. CLI가 실제 청구 금액을 제공하지 않으므로 `monetaryCost.status: UNAVAILABLE`을 비용 0으로 해석하지 마십시오.

현재 한도는 다음처럼 서로 다른 범위에 적용됩니다.

| 한도 | 적용 범위 |
|---|---|
| 64 | fact, procedure, case, open question 한 항목의 직접 evidenceRefs |
| 120 | 봉인된 source run 하나의 전체 frame catalog |
| 1~12 | Wiki 모델 한 번에 전달하는 검증 PNG working set |
| 10 | 120 frame source 하나를 분석할 때의 최대 fresh Wiki 호출 수 |

따라서 65 frame 실행은 정상 입력이며 64개 항목 증거 제한으로 거부되지 않습니다. 같은 지식에 65번째 이후 근거가 붙으면 지식을 복제하거나 근거를 자르지 않고 snapshot v3의 `evidenceSets`에 source별로 누적합니다. Wiki 본문에는 전체/direct/extended 수와 전체 근거 문서 링크가 표시됩니다. 기존 v1·v2 revision은 그대로 두며 다음 revision 생성 때 메모리에서 v3로 승격합니다. source와 기존 campaign snapshot의 구조·용량은 모델 호출 전에 사전검증하므로 이 단계가 실패하면 토큰을 사용하지 않습니다. `WIKI_INPUT_PRECHECK_FAILED`는 사전검증, `MODEL_PROPOSAL_INVALID`는 모델 제안 검증, `WIKI_MERGE_INVALID`는 누적 병합 실패를 뜻합니다.

이 수치는 게임 전체 지식량의 한도가 아닙니다. 한 source의 다중 분석은 이미 모든 frame을 batch로 분할해 수행합니다. 장시간 campaign에서는 07이 안전 checkpoint마다 새 sealed episode source를 만들고, 각 source를 독립적인 물리 Wiki에 게시합니다. 누적 catalog는 trusted page kind와 namespace를 우선하고 고정된 한국어·영어 어휘를 보조로 사용해 topic/episode shard로 자동 routing됩니다. 다음 Player에는 trusted routing hint와 episode를 기준으로 고른 최대 32개 top-K 지식만 전달합니다. 현재 live adapter는 고정된 `current episode` hint와 episode 순서를 사용하며 화면 문자열을 별도로 추출하지 않습니다. 현재 120 frame 상한은 episode 하나에 적용되며 여러 episode로 이어지는 campaign 전체 지식량 한도가 아닙니다. 게임 build별 namespace 분리도 아직 trusted adapter가 별도로 제공해야 합니다.

기본 정책은 최종 Host 상태가 `QUARANTINED`인 실행을 모두 거부하는 것입니다. 다만 이전 Vision Host가 `MODEL_TURN_FAILED`도 일반 격리로 끝내던 시기에 생성된 실행은 운영자가 다음 복구 옵션을 **단독으로 명시**할 수 있습니다.

```bat
wiki-builder.cmd --confirm-openai-upload --allow-recoverable-model-failure --run "D:\git\test_game\agent_tools\.local\vision-agent\<구형-hostRunId>"
```

이 옵션은 단순히 `QUARANTINED`를 무시하지 않습니다. 실패가 `DECIDING` 중 발생했고 실패 turn에 결정이나 입력이 없으며, 이전 전달 입력이 결과 프레임까지 정산됐고, 유일한 격리 원인이 `MODEL_TURN_FAILED`이고, `PARTIAL` end/seal receipt와 signed handoff 및 Host knowledge receipt가 모두 일치하는 경우에만 Wiki revision을 만듭니다. 다른 stop code, end/seal 오류, 실패 이후 입력, digest 불일치, 불완전 journal은 계속 거부됩니다. 복구된 source에는 `acceptanceBasis: EXPLICIT_OPERATOR_RECOVERY`와 원래의 `finalState: QUARANTINED`가 영구 보존됩니다.

새 Vision Host가 같은 실패를 `SEALED/PARTIAL`로 봉인한 실행에는 `--allow-recoverable-model-failure`가 필요하지 않습니다. 일반 명령으로 가져오며, source provenance에는 `acceptanceBasis: HOST_POLICY`, `terminationKind: MODEL_DECISION_FAILED_NO_ACTION`, `stopCode: MODEL_TURN_FAILED`가 남습니다.

Assisted Wiki 기능을 추가하기 전에 만든 기존 Vision 산출물에는 Host의 `knowledgeContext: NONE` 영수증이 없습니다. 그런 과거 실행만 가져오려면 운영자가 다음 옵션을 명시해야 합니다. 이 옵션은 서명 트랙이 `EXPLORATION`이고 validity가 `OFFICIAL`인 경우에만 허용되며 source에는 `knowledgeAttestation: LEGACY_OPERATOR_CONFIRMED`로 남습니다. 새 실행에는 이 옵션을 사용하지 마십시오.

```bat
wiki-builder.cmd --confirm-openai-upload --allow-legacy-unattested --run "D:\git\test_game\agent_tools\.local\vision-agent\<과거-hostRunId>"
```

`--allow-legacy-unattested`와 `--allow-recoverable-model-failure`는 서로 다른 신뢰 예외이며 동시에 사용할 수 없습니다. 둘을 함께 지정하면 명령 해석 단계에서 거부되고 업로드나 Wiki 모델 호출이 발생하지 않습니다.

기본 campaign은 다음 위치에 만들어집니다.

```text
D:\git\test_game\agent_tools\.local\assisted-wiki\default\revisions\r000001\
```

성공 결과의 주요 필드는 다음 의미입니다.

| 결과 | 의미 |
|---|---|
| `status: PUBLISHED` | 새 immutable revision 게시 성공 |
| `track: ASSISTED` | 공식 blind/STRICT 점수와 분리해야 함 |
| `source.hostStatus` | 일반 및 새 Host 정책 봉인은 `SEALED`; 구형 명시 복구는 원래 상태인 `QUARANTINED`를 보존 |
| `source.contentStatus: PARTIAL` | 플레이가 콘텐츠 완주를 주장하지 않음; 보지 못한 부분은 unknown |
| `source.explorationTrack` | 원본 실행이 `EXPLORATION`인지 Wiki를 참고한 `ASSISTED_EXPLORATION`인지 Runner 서명으로 검증한 값 |
| `source.knowledgeAttestation` | `HOST_RECEIPT`이면 새 계약으로 교차검증됨; `LEGACY_OPERATOR_CONFIRMED`이면 운영자가 과거 실행 호환을 명시적으로 허용함 |
| `source.provenance.finalState` | 원본 Host의 실제 최종 상태. 구형 명시 복구는 `QUARANTINED`, 정상 및 새 Host 정책 봉인은 `SEALED` |
| `source.provenance.terminationKind` | `NORMAL`은 일반 종료, `MODEL_DECISION_FAILED_NO_ACTION`은 행동 생성 전 모델 turn 실패 |
| `source.provenance.acceptanceBasis` | `STANDARD`, 새 Host의 `HOST_POLICY`, 구형 실행의 `EXPLICIT_OPERATOR_RECOVERY`를 구분 |
| `source.provenance.stopCode` | 정상 종료는 `null`; 모델 turn 실패 증거는 `MODEL_TURN_FAILED`를 그대로 보존 |
| `source.provenance.journalSha256` | 수용 판단에 사용한 bounded Host journal bytes의 digest |
| `source.provenance.endReceiptVerified`, `sealReceiptVerified` | 종료와 봉인 receipt 검증이 모두 성공했는지 표시 |
| `pages`, `cases`, `openQuestions` | 현재 누적 snapshot의 구조화 항목 수 |
| `selectedFrames` | 이번 source에서 실제로 분석한 전체 검증 frame 수 |
| `modelCalls` | 최대 12장씩 나눈 fresh Wiki Agent batch 호출 수 |
| `wikiIndex` | 사람이 읽을 Markdown Wiki 첫 페이지 |
| `playerContextFile` | 다음 Player에 줄 수 있는 4KB 이하 제한 지식 |
| `usage` | 모든 Wiki batch turn delta의 합계. 누락 turn이 있으면 `PARTIAL`, 전부 누락이면 `UNKNOWN` |
| `monetaryCost.status: UNAVAILABLE` | 비용 0이 아니라 CLI가 실제 청구 금액을 제공하지 않음 |

`PUBLISHED`는 파일·계약·증거 연결이 정상이라는 뜻이며 Wiki 내용이 정답이라는 뜻은 아닙니다. 각 문서의 evidence frame과 open question을 함께 검토하십시오. 모델/schema/증거 검증이 실패하면 기존 revision은 보존되고 새 revision은 생기지 않습니다.

성공 출력의 `revision: 2`는 같은 campaign의 두 번째 누적 immutable revision인 `revisions\r000002\`가 새로 게시됐다는 뜻입니다. 모델 호출 횟수는 `modelCalls`로 따로 확인하며 revision 번호와 같지 않습니다. 기존 `r000001`을 수정하거나 덮어쓰지 않습니다. 두 번째 revision의 snapshot에는 이전 source와 새 source의 provenance가 각각 보존되고, Wiki 문서와 `player-context.json`은 누적 결과를 반영합니다.

## 12. 다음 플레이가 이전 Wiki를 참고하게 하기

Wiki 생성 결과의 `playerContextFile` 절대 경로를 환경 변수에 지정하고 새 플레이를 시작합니다.

```bat
set ATLAS_WIKI_CONTEXT_FILE=D:\git\test_game\agent_tools\.local\assisted-wiki\default\revisions\r000001\player-context.json
vision-player.cmd --confirm-openai-upload
```

이 실행의 종료 JSON에는 다음처럼 표시됩니다.

```json
"knowledgeContext": {
  "status": "ASSISTED",
  "revision": 1,
  "itemCount": 8
}
```

Player는 알려진 화면을 더 빨리 인식할 수 있지만 현재 픽셀을 반드시 다시 확인합니다. 과거 키 입력, 좌표, frame ID, 실행 경로, digest, 행동 매크로는 context에 포함되지 않습니다. 과거 내용과 다른 결과가 보이면 안전하게 탐사하고 보이는 프레임을 북마크하도록 지시됩니다. 한 화면당 한 행동과 기존 키/시간 예산도 그대로 유지됩니다.

두 번째 플레이가 끝나면 새 `outputDirectory`로 `wiki-builder.cmd`를 다시 실행합니다. 같은 기본 campaign 또는 같은 `--campaign` 절대 경로를 사용하면 latest snapshot을 자동으로 읽어 `r000002`를 만듭니다. 동일 사실은 evidence를 합치고, 같은 조건의 다른 outcome은 별도 case로 추가합니다. 같은 플레이 산출물을 다시 넣으면 모델 호출 전에 `SOURCE_ALREADY_IMPORTED`로 거부하므로 revision을 부풀릴 수 없습니다.

```bat
wiki-builder.cmd --confirm-openai-upload --run "D:\git\test_game\agent_tools\.local\vision-agent\<두번째-hostRunId>"
set ATLAS_WIKI_CONTEXT_FILE=D:\git\test_game\agent_tools\.local\assisted-wiki\default\revisions\r000002\player-context.json
```

비교용 사전 지식 없는 실행으로 돌아가려면 새 터미널을 열거나 다음처럼 변수를 비웁니다.

```bat
set ATLAS_WIKI_CONTEXT_FILE=
```

사전 지식 없는 결과와 ASSISTED 결과를 같은 점수로 합치지 마십시오. `vision-player.cmd`는 Wiki context가 없으면 Runner 산출물에 `EXPLORATION`과 `validity: OFFICIAL`, 있으면 `ASSISTED_EXPLORATION`과 `validity: ASSISTED`를 함께 서명하고 종료 JSON에도 같은 `explorationTrack`을 표시합니다. 사용자가 별도 환경 변수로 이 분류를 덮어쓸 수 없으며 Wiki ingress가 서명, validity, Host의 실제 knowledge-context 영수증을 교차 확인합니다. 반복 Wiki는 “이미 파악한 내용을 활용해 새 사례를 얼마나 더 발견하는가”를 보는 운영 트랙이고, 순수 콘텐츠 이해 능력의 공식 baseline은 이전 Wiki 없이 별도로 실행해야 합니다.

## 13. 자동 checkpoint campaign 검증

먼저 실제 모델·업로드·OS 입력 없이 전체 checkpoint 흐름을 검사합니다.

```bat
cd /d D:\git\test_game\agent_tools
test.cmd checkpoint-campaign
```

이 명령은 07 코어와 trusted integration adapter를 모두 fake로 검사합니다. 25 frame segment가 12/12/1의 세 fresh Wiki batch로 처리되는지, 정확한 publish ACK와 snapshot/context digest가 확인되기 전 다음 Player가 시작되지 않는지, episode별 물리 Wiki와 topic/episode shard가 생성되는지, 관련 top-K context가 새로운 `sessionMode: FRESH` segment에만 전달되는지 확인합니다. 외부 모델 호출이나 실제 게임 입력은 없습니다.

Checkpoint는 Codex가 언제 내부 context compaction을 수행했는지 추측해서 발생하지 않습니다. Vision Host가 다음 모델 판단을 시작하기 전에 저장된 현재 frame/hash, pending 입력 부재, journal 상태를 확인하고 다음 중 하나가 명시적 정책값에 도달했을 때 안전한 `SEALED/PARTIAL` 경계를 만듭니다.

- 마지막으로 보고된 모델 input token이 rollover 기준 55,000보다 낮은 선제 threshold에 도달
- segment의 키 입력 시도 수가 threshold에 도달
- segment의 관찰 frame 수가 threshold에 도달
- 정책이 허용한 상태에서 모델 사용량 보고가 누락

그 뒤 순서는 `sealed episode → 전체 frame batch Wiki → exact ACK → digest-bound selected context → fresh Player session`으로 고정됩니다. Wiki 게시나 context 검증이 실패하면 다음 Player를 시작하지 않고 같은 idempotency key의 단계만 재시도합니다. 새 세션을 열어도 turns, key attempts, frames, elapsed time, checkpoint 수의 campaign 누적 예산은 복구되지 않습니다.

이 자동 반복은 이미 아는 내용을 활용해 새로운 사례를 찾는 `ASSISTED` 운영 트랙입니다. 공정한 baseline은 이전 Wiki를 주지 않은 `STRICT/EXPLORATION` 실행으로 별도 측정해야 합니다.

### 실제 선택 창에서 자동 campaign 실행

먼저 게임을 시작하고 4절처럼 승인할 창의 HWND를 찾습니다. 첫 실제 확인은 비용과 입력 범위를 줄이기 위해 checkpoint 1회로 시작하십시오.

```bat
cd /d D:\git\test_game\agent_tools
test.cmd windows
set ATLAS_TARGET_HWND=123456
set ATLAS_ALLOWED_KEYS=ArrowUp,ArrowDown,ArrowLeft,ArrowRight,Enter,Tab,Space,Shift,KeyB,KeyC,KeyF
set ATLAS_VISION_ARM_DELAY_MS=10000
campaign-player.cmd --confirm-openai-upload --checkpoints 1
```

`123456`은 실제 승인 창의 값으로 바꿉니다. 첫 segment만 arm delay를 사용하고 이후 fresh segment는 자동으로 이어지므로 campaign이 끝날 때까지 같은 게임 창을 foreground로 유지하고 가리지 마십시오. `--checkpoints`는 1~10이며 기본값은 3입니다. N은 지식 checkpoint의 최대 횟수입니다. 모델이 먼저 COMPLETE/PARTIAL/ABORT로 끝나면 그 terminal 증거를 자동 게시하고, N번째 checkpoint에 먼저 도달하면 그 episode를 게시한 뒤 추가 fresh segment 없이 `FINISHED/PARTIAL`로 끝납니다.

live 정책은 segment마다 최대 40 turns, 20 key attempts, 60 frames, 900,000ms이고 모델 재시작 1회와 55,000-token rollover 경계를 유지합니다. checkpoint는 45,000 model input tokens, 12 key attempts, 24 frames 또는 usage 누락 중 하나에서 먼저 요청됩니다. campaign 전체 예산은 선택한 checkpoint 수에 맞춰 계산되지만 fresh session마다 이미 사용한 예산이 되돌아오지는 않습니다.

화면은 Player 판단과 Wiki batch 양쪽에서 OpenAI로 전송될 수 있습니다. 한 checkpoint가 24 frame에서 발생하면 Wiki Agent도 보통 12장씩 2회 호출되며, 모델이 checkpoint 전에 terminal 결정을 내린 경우에는 그 마지막 episode도 별도로 게시됩니다. 즉 `--checkpoints`를 늘리면 Player와 Wiki의 모델 호출·token 사용량이 함께 증가합니다. `--confirm-openai-upload`는 이 두 전송을 모두 승인한다는 뜻이며, 비용 상태가 `UNAVAILABLE`이어도 무료라는 뜻이 아닙니다.

기본 산출물은 다음 위치에 새 campaign UUID로 저장됩니다.

```text
D:\git\test_game\agent_tools\.local\checkpoint-campaign\<campaignId>\
```

부모 위치를 바꾸려면 실행 전에 절대 경로 `ATLAS_CHECKPOINT_STATE_DIR`를 지정합니다. 주요 산출물은 `episodes/eNNNNNN/revisions/r000001`의 episode Wiki, `routing/rNNNNNN`의 topic/episode shard와 `selected-context.json`, `ledger.json`, 그리고 종료 JSON의 각 Player `outputDirectory`입니다.

성공 여부는 다음 필드를 함께 봅니다.

| 결과 | 의미 |
|---|---|
| `status: FINISHED`, `reason` | 정상 종료. `reason: PARTIAL`은 checkpoint 한도 도달 또는 Player의 부분 종료일 수 있음 |
| `segments`, `checkpoints` | 실제 fresh Player segment와 완료된 지식 checkpoint 수 |
| `campaignRevision` | 다음 Player에 ACK 검증 후 활성화한 context revision |
| `wikiRevision` | checkpoint context revision에 별도 terminal episode 게시가 있으면 그것까지 포함한 Wiki revision |
| `wiki.terminalEvidencePublished: true` | checkpoint continuation이 없는 마지막 COMPLETE/PARTIAL/ABORT segment 증거가 별도로 게시됨 |
| `player.usage`, `wiki.usage` | Player/Wiki 모델 사용량을 분리한 합계 |
| `wiki.modelCalls` | 모든 episode에서 사용한 fresh Wiki batch 호출 총수 |
| `ledgerFile`, `ledgerDigest` | 경로·키·화면을 제외한 campaign lifecycle hash-chain 기록 |

`WAITING_FOR_WIKI` 또는 `WAITING_FOR_CONTEXT`는 다음 Player가 시작되기 전에 Wiki 게시 또는 context 로드가 두 번의 bounded retry 뒤에도 끝나지 않았다는 뜻입니다. `FAILED`는 ACK/digest/예산/계약 검증 실패입니다. 두 경우 모두 새 키 입력을 임의로 재시도하지 말고 `ledger.json`, episode Wiki 산출물, 종료 JSON을 보존해 원인을 확인합니다.
