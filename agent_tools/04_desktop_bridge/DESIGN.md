# 04 Desktop Bridge 설계

## 목표

Desktop Bridge는 브라우저 프로토콜이나 게임 내부 API 없이 운영자가 선택한 Windows 창의 **현재 화면 픽셀**을 캡처하고, 그 창에만 제한된 키보드·마우스 입력을 전달합니다. Player Agent는 URL, DOM, 프로세스, HWND, 데스크톱 좌표를 알 수 없습니다.

```text
Trusted Operator
  ├─ window + optional client region 선택
  └─ capture/input provider 선택(세션 시작 전 고정)
                  │ private HWND / identity / region
                  ▼
          TargetBindingBroker
                  │ withPrivateBinding: 매 호출 직전 공통 재검증
                  ▼
Player Runner ─ DesktopWindowAdapter
                  ├─ CaptureBroker ─ CaptureProvider
                  └─ SafeInputBroker ─ InputProvider
                                      │ stable provider contracts
                                      ▼
                              .NET Native Bridge
                              ├─ common target/state guard
                              ├─ IFrameCaptureBackend → GDI (기본)
                              └─ IInputBackend → SendInput (기본)
```

## 대상 결박

운영자가 창을 선택하면 다음 값이 비공개 binding으로 고정됩니다.

- top-level HWND
- PID와 프로세스 시작 시각
- 실행 파일 SHA-256
- client width/height
- 선택한 client-relative capture region

`CaptureBroker`와 `SafeInputBroker`는 모두 `TargetBindingBroker.withPrivateBinding`을 통과합니다. 이 공통 gate는 provider를 부르기 직전에 `inspect`하여 HWND 재사용, PID/프로세스 시작 시각, 실행 파일 hash, client width/height가 pin과 정확히 일치할 때만 비공개 `{targetIdentity,region}`을 callback에 전달합니다. 하나라도 달라지면 binding과 관련 ticket을 폐기하고 운영자가 다시 선택해야 합니다. 네이티브 guard도 OS primitive 직전에 identity, geometry, visibility, minimized/foreground 및 capture/hit-test 조건을 독립적으로 검사합니다. AI에는 일회성 launch ticket에서 파생된 `targetRef`조차 노출되지 않습니다.

## 화면 캡처

JS `CaptureProvider`의 exact descriptor는 `{providerId,capture}`이고, `capture({binding,region})`는 exact `{rawBytes,width,height,providerId}`를 반환합니다. `CaptureBroker`는 공통 재검증 뒤 provider를 최대 한 번 호출하고 provider ID, pinned 크기, PNG의 `IHDR`/`IDAT`/`IEND` 구조를 검사합니다. 실패 시 sanitized error로 닫히며 다른 provider를 시도하지 않습니다.

현재 기본 provider/backend는 `gdi-composited-screen/v1`과 `GdiFrameCaptureBackend`입니다. 현재 가상 데스크톱에 실제로 합성된 픽셀만 PNG로 복사합니다. 대상은 foreground이고 최소화되지 않았으며 선택 영역이 다른 top-level 창에 가려지지 않아야 합니다. 조건이 어긋나면 다른 화면을 대신 반환하지 않고 실패합니다.

이 정책은 사람에게 보이는 화면과 AI 화면을 맞추기 위한 strict 평가용입니다. 높은 FPS나 특정 DirectX surface가 필요하면 stable `CaptureProvider`와 native `IFrameCaptureBackend` 뒤에 `Windows.Graphics.Capture` 또는 DXGI 구현을 별도로 추가합니다. 픽셀 외 정보가 공개 경계를 넘어서는 안 되며 같은 요청이나 세션 안에서 GDI로 자동 fallback해서는 안 됩니다.

## 입력

JS `InputProvider`는 `dispatch(action,pinnedTarget)` capability 하나를 제공하고 exact `{status,sinkReceipt}`를 반환합니다. 상태는 `DELIVERED`, `NOT_DELIVERED`, `DELIVERY_UNKNOWN` 중 하나이며 receipt는 target이나 좌표 의미가 없는 bounded token입니다. provider descriptor에는 v1 public `providerId`가 없습니다.

키보드는 공용 campaign profile의 20개 key code만 받습니다. 현재 기본 native `IInputBackend`는 `SendInputBackend`이며 receipt는 `win-sendinput`입니다. 네이티브 helper는 target identity와 foreground 상태를 같은 critical section에서 확인한 뒤 keyDown/keyUp을 한 번만 시도합니다.

마우스는 AI가 데스크톱 좌표를 제출하지 않습니다. Player Runner의 frame-bound `optionRef`가 신뢰된 resolver에서 private client-relative safe point로 해석된 경우에만 `safeClick`이 호출됩니다. point가 binding region 밖이거나 현재 hit-test가 다른 창을 가리키면 입력하지 않습니다. 현재 범용 adapter에는 visual target detector가 연결되어 있지 않아 공개 object option은 생성되지 않습니다.

정책/재검증 거부와 명시적인 미전달은 `NOT_DELIVERED`입니다. 입력 결과가 부분 전달되었거나 provider가 throw하거나 malformed 결과를 반환하거나 transport가 끊긴 경우 `DELIVERY_UNKNOWN`으로 남깁니다. provider는 한 번만 호출하며 두 상태 모두 자동 재시도하거나 다른 provider로 fallback하지 않습니다.

## Provider 선택과 교체

provider 선택은 세션 조립 전 trusted operator/bootstrap의 권한입니다. Player Runner action, AI-facing 도구, native NDJSON에는 provider 선택 필드가 없고 실행 중 hot swap도 허용하지 않습니다. 현재 repository는 공개 runtime provider 선택 switch를 제공하지 않으며 trusted composition/native code에 GDI와 SendInput 기본값이 고정되어 있습니다. 향후 선택 설정을 추가해도 operator-only여야 합니다. production bootstrap은 하나의 native process를 두 stable provider adapter에 명시적으로 감싸 주입하며, `DesktopWindowAdapter`는 raw bridge를 알지 못합니다. adapter 종료 시 provider lifecycle은 공유 resource를 한 번만 닫습니다.

provider를 바꾸려면 기존 세션 종료와 lifecycle close → 운영자 재선택/재bind → 새 launch ticket → 새 세션 순서를 따릅니다. capture provider ID는 `capturePolicyDigest`에 포함됩니다. input 경로는 `inputPolicyVersion`으로 attestation하므로 delivery 의미가 달라지는 backend 교체 전 `DESKTOP_INPUT_POLICY_VERSION`을 올려야 합니다. 이전 digest/version을 새 provider와 재사용하지 않습니다.

## 구현 구성

- `native/**`: .NET 9, Win32 window/GDI/SendInput, strict NDJSON
- `src/targeting/**`: operator candidate, identity pin, opaque ticket/ref
- `src/provider-contract.mjs`: CaptureProvider descriptor, legacy bridge migration adapter, shared lifecycle
- `src/capture/**`: 공통 target revalidation 뒤 one-shot provider capture와 PNG 검증
- `src/input/**`: InputProvider 계약, fixed action validation과 delivery 분류
- `src/native-client.mjs`: 네이티브 프로세스 수명주기와 protocol validation
- `src/desktop-window-adapter.mjs`: broker만 받는 기존 Player Runner adapter 계약 연결
- `integration/local-runner-bootstrap.mjs`: 운영자가 정한 HWND/provider를 조립하는 로컬 MCP bootstrap
- `scripts/list-windows.mjs`: 운영자 전용 창 목록
- `scripts/live-window-smoke.mjs`: 실제 선택 창 capture→key→capture 검사

## 보안 불변식

- AI-facing tool에는 URL, HWND, PID, path, hash, region, 좌표 필드가 0개입니다.
- 브리지는 DOM, accessibility tree, 프로세스 메모리, 네트워크, 게임별 API를 사용하지 않습니다.
- 대상 창을 자동으로 focus하거나 다른 창으로 retarget하지 않습니다.
- window identity와 geometry가 달라지면 fail closed 합니다.
- capture region 밖 click과 allowlist 밖 key는 OS 호출 전에 거부합니다.
- provider는 요청당 최대 한 번 호출하며 자동 fallback과 ambiguity 재시도를 금지합니다.
- provider 선택/변경은 운영자만 수행하고 변경 시 새 세션·재bind·새 policy attestation을 사용합니다.
- native stdout은 protocol JSON 전용이며 상세 진단은 stderr에만 기록합니다.

## 검증 범위

- .NET Release build: warning/error 0
- native self-test: malformed/duplicate/unknown JSON, zero-size, key allowlist, region edge, PNG
- TargetBindingBroker의 ticket/identity/geometry 공통 gate
- CaptureBroker의 provider/PNG/크기/무 fallback 경계
- SafeInputBroker의 allowlist/region/상태 분류/최대 1회 호출
- native fake `IFrameCaptureBackend`/`IInputBackend`와 보수적 delivery 분류
- DesktopWindowAdapter 및 Player Runner lifecycle
- 실제 Windows top-level window enumeration
- assigned directory import와 native DLL allowlist

실제 AI 모델의 콘텐츠 이해, 위키 생성, 재현 캠페인은 이 모듈의 테스트 대상이 아닙니다.

## 알려진 제약

- GDI composited capture가 검은 화면을 반환하는 보호 surface나 일부 exclusive fullscreen 게임에는 WGC/DXGI backend가 필요합니다.
- `SendInput`은 안티치트 또는 권한 무결성 수준에 따라 거부될 수 있습니다. 승인된 QA 환경에서만 검증합니다.
- foreground/unobscured 정책 때문에 운영자가 평가 중 다른 창을 앞에 띄우면 run이 일시 실패합니다.
- visual object detector와 실제 AI client는 아직 연결되지 않았습니다.
