# Contract Pack: Atlas Protocol

이 패키지는 모듈 구현자가 공유할 수 있는 유일한 runtime 계약입니다.

허용 범위:

- `src/`의 canonicalization, digest, signature, allowlist validator
- `schemas/`의 공개 JSON Schema
- `fixtures/`의 합성 정상·공격 입력

금지:

- 실제 게임 콘텐츠, seed, canonical truth
- 다른 모듈 source
- production signing key
- schema에 없는 확장 필드

수용 명령: `node scripts/verify.mjs`
