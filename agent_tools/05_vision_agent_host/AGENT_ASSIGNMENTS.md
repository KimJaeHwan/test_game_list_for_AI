# Vision Agent Host 구현 배정 기록

## 지식 최소화 원칙

각 구현자는 자신의 경계 계약과 합성 fixture만 받습니다. 현재 Codex 서브에이전트는 같은 파일 시스템을 공유하므로 이 배정은 책임 분리와 교차 검토를 제공하지만 보안 격리를 증명하지 않습니다. 실제 blind 개발에는 `BLIND_DEVELOPMENT.md`의 별도 VM/container 절차가 필요합니다.

| 배정 | 소유 경로 | 입력 | 금지/비소유 |
|---|---|---|---|
| Model Port Agent | `src/model/**`, 모델 포트 검증 | PNG 경로, 고정 프롬프트, JSON Schema, Codex process events | Runner 호출, 게임 규칙, 평가/문서 모듈 |
| Runner Client Agent | `src/runner/**`, Runner client 검증 | 고정 JSON-RPC 메서드와 구조화 응답 | 모델 프롬프트, 화면 해석, 정책 결정 |
| Supervisor Agent | `src/supervisor/**`, supervisor 검증 | 두 injected port, ModelAction, 상태/예산 계약 | 실제 Codex 실행, OS 입력 API, 게임 의미 |
| Integration Coordinator | package/index/CLI/docs/root tests | 공개 export와 수용 테스트 | live seed, production key |

## v1 검증 결과

- Model Port Agent: fake Codex 39 cases 통과(usage exact shape·누락·오버플로·known optional counter 포함)
- Runner Client Agent: JSON-RPC, timeout, output cap, graceful cleanup 검증 통과
- Supervisor Agent: fake port 33 cases 통과(turn delta 합산·누락·격리·invalid action 이전 기록 포함)
- Integration Coordinator: 실제 Player Runner stdio lifecycle + fake model token 합산·usage 파일 저장 검증 통과
- 실제 OS 키 입력: 운영자가 scan-code backend 수정 뒤 동작 확인
- 실제 Codex 이미지 전송: 운영자 3회 시도 중 앞선 2회는 구형 provider schema, 3회째는 Supervisor/ModelPort root fixture drift로 첫 판단 전 실패; 두 원인 수정 뒤 재검증 대기
