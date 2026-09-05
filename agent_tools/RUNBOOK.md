# Atlas Agent Tools 로컬 실행 런북

## 1. 무엇이 실행되는가

구현은 서로 다른 책임을 가진 네 영역으로 나뉩니다.

1. **Desktop Bridge**는 운영자가 선택한 Windows 창과 세션 시작 전에 고정한 capture/input provider를 통해 합성 화면 PNG와 제한 OS 입력을 제공합니다.
2. **Player Runner**는 그 프레임과 허용된 행동만 AI에게 제공하고 증거를 봉인합니다.
3. **Wiki Foundry**는 봉인된 프레임·행동 증거만 읽고 사실, 관계, 절차, 모순, 미확인을 위키 문서로 정규화합니다.
4. **Replay Judge**는 새 상태와 변형된 화면에서 문서의 절차를 다시 실행하고 성공 여부와 누출을 판정합니다.

좌표는 신뢰 경계 밖으로 나오지 않습니다. AI가 받는 것은 허용 키 코드 또는 프레임에 묶인 일회성 `optionRef`이며, 실제 좌표 변환은 Runner 내부 adapter만 수행합니다. URL, DOM, CDP, accessibility tree, 프로세스 메모리는 기본 Desktop Bridge 경로에서 사용하지 않습니다. 현재 범용 연결에는 visual target detector가 없으므로 object option 목록은 비어 있습니다.

## 2. 사전 조건

- Node.js 22.13 이상
- .NET 9 SDK와 Windows Desktop Runtime
- `03_quest_atlas` 의존성 설치 완료
- Windows 10 이상

모든 기본 검증은 로컬 파일과 로컬 게임만 사용합니다. OpenAI API, ChatGPT 업로드, 외부 저장소 업로드는 자동으로 수행하지 않습니다.

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
test.cmd boundaries
```

사용 가능한 이름과 설명은 `test.cmd list`로 확인합니다. `live-window`는 사용자가 실제 대상 창을 고르고 foreground로 전환해야 하므로 자동 전체 테스트에는 포함되지 않습니다.

전체 suite는 공용 서명 계약, Runner의 exact-once 입력과 파일 봉인, Foundry의 증거 폐쇄성, Judge의 fresh replay, 실제 Quest Atlas reducer, Desktop Bridge 네이티브 빌드와 정책, 세 모듈 종단 흐름, Contract Pack 경계를 검사합니다.

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

공개 산출물의 모든 파일은 manifest의 SHA-256과 크기로 1:1 검증됩니다. 공개·비공개 루트 중첩, 덮어쓰기, 경로 이탈은 실패 처리됩니다.

## 8. 현재 MVP의 경계

- 실제 VLM/LLM 모델 호출과 프롬프트 orchestration은 포함하지 않습니다. 따라서 코드만 실행해서 AI 사용료가 발생하지 않습니다.
- Foundry는 현재 라이브러리와 검증 파이프라인이며 별도 편집 UI는 없습니다.
- 로컬 bootstrap은 실행마다 임시 Ed25519 키를 만듭니다. 운영 배포에는 지속 Key Service와 키 보관 정책이 필요합니다.
- 범용 Desktop Bridge의 안전 click primitive와 object-action resolver는 구현했지만, 화면에서 클릭 후보를 생성하는 visual target detector는 아직 연결하지 않았습니다. 현재 공개 option 목록은 비어 있습니다.
- v1 기본 `IFrameCaptureBackend`는 foreground의 현재 합성 픽셀을 GDI로 복사합니다. 일부 보호 surface, exclusive fullscreen, 특정 DirectX 게임이 검은 화면을 반환하면 6절 절차로 WGC/DXGI backend를 도입해야 하며 런타임 자동 fallback은 하지 않습니다.
- v1 기본 `IInputBackend`는 `SendInput`입니다. 안티치트나 무결성 수준에 따라 거부될 수 있으므로 승인된 QA 클라이언트·계정·환경에서만 사용하며 다른 입력 API로 자동 우회하지 않습니다.
- Contract Pack exporter와 경계 검사는 구현했지만 이 환경에서는 Docker daemon을 사용할 수 없어 개발 프로세스의 OS 수준 파일 격리는 실행 검증하지 못했습니다.
- 실제 AI 세 종류를 사용한 blind baseline/candidate/oracle 캠페인은 아직 실행하지 않았습니다. Judge는 그 실험을 받을 계약과 재생 경로까지 제공합니다.

이 상태는 **로컬 scripted E2E와 범용 Windows 창 열거까지 검증된 개발 MVP**입니다. 실제 선택 창의 capture/input은 4절의 `live-window`를 운영자가 foreground 전환과 함께 확인합니다. 다음 단계는 모델 클라이언트를 Runner stdio에 연결하고, 동일한 holdout campaign을 여러 모델에 반복 실행해 탐사·위키·재현 점수를 수집하는 것입니다.

## 9. 레거시 CDP adapter

`integration/quest_atlas/browser-adapter.mjs`와 `test.cmd live-browser`는 웹 개발 중 Canvas adapter를 비교·회귀 검사하기 위해 남겨 둡니다. 기본 Player Runner 연결에는 사용하지 않으며, 메이플스토리형 GUI 평가의 근거로 해석하지 않습니다.
