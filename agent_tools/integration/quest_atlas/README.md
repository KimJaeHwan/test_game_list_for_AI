# Quest Atlas trusted integration

이 디렉터리는 `03_quest_atlas`를 Atlas Agent Tools에 연결하는 신뢰 경계 내부 코드입니다.

- `browser-adapter.mjs`: loopback CDP 연결, Canvas PNG 캡처, 허용 키 전달
- `local-runner-bootstrap.mjs`: one-time launch ticket, Coordinator ID, 로컬 키와 artifact 저장소 구성
- `engine-adapter.mjs`: 실제 Quest Atlas generator/reducer를 fresh state로 재생
- `verify.mjs`: source/transfer 설정을 각각 두 번 재생하여 결정성과 완료 여부 확인
- `verify-browser-adapter.mjs`: 외부 브라우저 없이 CDP adapter 계약 검사
- `live-browser-smoke.mjs`: 실행 중인 실제 브라우저의 캔버스와 키 입력 smoke test

이 코드는 AI에게 DOM, selector, target URL 또는 좌표를 반환하지 않습니다. 브라우저의 실제 좌표와 CDP 세션 정보는 adapter 내부에만 유지됩니다. 전체 실행 순서는 [로컬 실행 런북](../../RUNBOOK.md)을 따릅니다.
