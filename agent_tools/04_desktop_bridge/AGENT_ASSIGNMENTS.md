# Desktop Bridge 구현 배정 기록

공용 계약을 먼저 `CONTRACT.md`와 `src/contract.mjs`로 고정한 뒤 구현 경로를 겹치지 않게 분리했습니다. 아래 표는 최종 모듈 소유 경계입니다. 공유 filesystem에서 통합이 필요하더라도 담당 경로 밖 구현은 해당 owner에게 인계하고, interface 이름·exact shape·오류 의미만 전달합니다.

| 담당 역할/task | 소유 경로 | 책임/교환 계약 | 독립 검증 |
|---|---|---|---|
| shared contract owner | `CONTRACT.md`, `src/contract.mjs` | protocol/policy version, exact records, identity/region, 공용 key allowlist | 계약 fixture와 consumer 정합성 |
| `desktop_native_bridge` | `native/**` | strict NDJSON, common Windows guard, `IFrameCaptureBackend`, `IInputBackend` | Release build, native self-test/fake backend |
| `desktop_target_broker` | `src/targeting/**` | operator candidate, identity/geometry pin, one-time ticket, `withPrivateBinding` | ticket/revalidation/invalid-state unit test |
| capture/provider owner | `src/provider-contract.mjs`, `src/capture/**` | stable CaptureProvider, one-shot PNG 검증, lifecycle | fake provider, malformed/throw/no-fallback test |
| `desktop_safe_input` | `src/input/**` | stable InputProvider, private action, allowlist/region, delivery 분류 | fake provider, zero-dispatch/max-one-call test |
| adapter/integration owner | `src/desktop-window-adapter.mjs`, `integration/**`, `scripts/**`, 관련 integration test | broker 조립, 기존 Runner API, operator-only provider 선택, live smoke | adapter/Runner E2E, boundary, non-live syntax |
| docs owner | `DESIGN.md`, `RUNBOOK.md`, 관련 README | 운영 절차, provider 교체 checklist, 공개/비공개 경계 | 구현 symbol과 명령 대조 |

native owner는 애플리케이션 종류를 모르며 OS primitive만, targeting owner는 identity pin과 공통 revalidation gate만, capture/input owner는 각 provider 결과와 정책만 다룹니다. adapter owner만 이 출력들을 기존 Runner 계약에 조립합니다. provider 구현은 targeting 내부 저장소에 접근하지 않고 `withPrivateBinding` callback 값만 받으며, adapter는 raw native bridge를 받지 않습니다.

Provider 교체도 이 경계를 넓히지 않습니다. trusted integration owner가 세션 시작 전에 구현을 선택하고, 해당 provider/backend owner가 계약·오류·fake test를 책임집니다. 변경 시 새 세션/재bind/policy attestation을 사용하고 자동 fallback을 추가하지 않습니다. native 기본 소유 구현은 GDI capture와 SendInput이며, JS migration adapter는 기본 native client를 stable provider 계약에 맞추는 용도일 뿐 fallback 경로가 아닙니다.

이번 Codex 환경의 subagent들은 같은 filesystem을 공유하므로 이는 지식 최소화와 path ownership을 통한 역할 분리입니다. 강한 보안 격리를 주장하려면 [블라인드 개발 운영](../BLIND_DEVELOPMENT.md)의 `.git` 없는 별도 VM/container와 OS ACL을 사용해야 합니다.
