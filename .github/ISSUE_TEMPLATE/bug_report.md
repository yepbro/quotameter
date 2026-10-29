---

name: Bug report
about: Report something that works incorrectly
title: ""
labels: bug
body:

- type: markdown
  attributes:
  value: |
  **Please write in English.**

      **Do not paste API keys, passwords, tokens, cookies, or full raw provider responses.** Quotameter issues are public — redact secrets before submitting.

- type: textarea
  id: description
  attributes:
  label: Description
  description: A clear description of the problem.
  validations:
  required: true
- type: textarea
  id: steps
  attributes:
  label: Steps to reproduce
  placeholder: | 1. Run `quotameter ...` 2. Open ... 3. Observe ...
  validations:
  required: true
- type: textarea
  id: expected
  attributes:
  label: Expected behavior
  description: What you expected to happen.
  validations:
  required: true
- type: textarea
  id: actual
  attributes:
  label: Actual behavior
  description: What actually happened, including any error messages (redacted).
  validations:
  required: true
- type: textarea
  id: environment
  attributes:
  label: Environment
  description: OS and version, Node.js version (`node -v`), quotameter version, installation method (npm/systemd/user service/Docker), provider and account count.
  placeholder: Ubuntu 24.04, Node 22.13.0, quotameter 1.0.0, npm + system service, Z.ai Coding Plan × 2
  validations:
  required: true
- type: textarea
  id: logs
  attributes:
  label: Relevant logs
  description: Redacted log excerpts or `journalctl --user -u quotameter` output. Remove any secrets first.
  validations:
  required: false
