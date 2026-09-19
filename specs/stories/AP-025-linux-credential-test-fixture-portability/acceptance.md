# Acceptance Criteria

## Happy Path

- [x] AC-01: the expected-valid `0700` credential directory and `0600`
      credential files load successfully for a non-root Linux process when every
      ancestor satisfies the production trust contract.

## Business Rules

- [x] AC-02: a writable ancestor and a group-readable credential file are each
      rejected with `daemon_credentials_invalid`, and the test proves the reader
      does not repair their modes.

## Failure Cases

- [x] AC-03: the focused credential test passes with Linux's default `/tmp`
      remaining `01777`; the valid fixture must not rely on weakening that mode or
      production validation.

## Regression Requirements

- [x] AC-04: `pnpm run test:platform-neutral` and `make verify` pass for the
      same candidate.

## Acceptance Evidence

| AC | Method | Evidence | Fixture / precondition | Expected observation |
| --- | --- | --- | --- | --- |
| `AC-01` | test    | `tests/unit/daemon-credentials.test.ts`                      | `non-root Linux process and protected writable fixture root` | `valid credentials resolve with both expected values`               |
| `AC-02` | test    | `tests/unit/daemon-credentials.test.ts`                      | `0640 credential file and 0770 ancestor fixtures`            | `both reads reject with the stable code and modes remain unchanged` |
| `AC-03` | command | `pnpm exec vitest run tests/unit/daemon-credentials.test.ts` | `non-root Linux with default 01777 /tmp`                     | `all credential unit tests pass without production source changes`  |
| `AC-04` | command | `pnpm run test:platform-neutral && make verify`              | `same AP-025 candidate`                                      | `both commands exit zero`                                           |

## Security Fixture Matrix

| Source field | Payload | Expected result | Persisted locations | Verification |
| --- | --- | --- | --- | --- |
| `credentialsDirectory` | `protected-root/unsafe-parent/credentials` | reject          | `none`              | `tests/unit/daemon-credentials.test.ts` |

## Verification Notes

The focused Linux command is the CI regression loop. Existing non-skipped
systemd acceptance tests remain the authority for real `LoadCredential`
delivery; this Story does not alter that production behavior.
