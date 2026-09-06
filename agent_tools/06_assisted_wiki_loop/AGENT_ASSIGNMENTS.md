# Assisted Wiki Loop 에이전트 배정 기록

개발 시 전체 목적을 각 구현자에게 공유하지 않고 다음 경계로 분리했습니다.

| 역할 | 소유 경로 | 전달된 책임 |
|---|---|---|
| Wiki Core Agent | `06_assisted_wiki_loop/src/core` | exact validation, stable ID, merge, render, bounded context |
| Wiki Model Port Agent | `06_assisted_wiki_loop/src/model` | fresh Codex process, PNG/frame allowlist, strict proposal |
| Vision Context Agent | `05_vision_agent_host/src/supervisor` | bounded untrusted context injection, journal redaction |
| Integration Coordinator | `integration/assisted_wiki_loop` | sealed evidence verification, immutable staging, CLI publication |
| Ingress Reviewer | read-only | path/signature/TOCTOU/prompt boundary adversarial review |

각 모듈은 독립 fake 테스트를 먼저 통과한 뒤 통합 담당자가 공개 API로만 연결했습니다. Ingress 리뷰에서 발견한 검증 후 원본 이미지 교체 가능성, Host seal 미결합, manifest 총량 미제한, frame selection 부족을 통합 계층에서 보강했습니다.
