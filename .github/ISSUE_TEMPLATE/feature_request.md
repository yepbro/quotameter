---

name: Feature request
about: Suggest an idea or improvement
title: ""
labels: enhancement
body:

- type: markdown
  attributes:
  value: |
  **Please write in English.**

      **Do not paste API keys, passwords, tokens, or personal account data.** Describe configuration values with placeholders instead of real secrets.

- type: textarea
  id: problem
  attributes:
  label: Problem or motivation
  description: What problem does this feature solve, or what is hard to do today?
  validations:
  required: true
- type: textarea
  id: solution
  attributes:
  label: Proposed solution
  description: What you would like to happen.
  validations:
  required: true
- type: textarea
  id: alternatives
  attributes:
  label: Alternatives considered
  description: Other workarounds or approaches you have tried or considered.
  validations:
  required: false
- type: textarea
  id: context
  attributes:
  label: Additional context
  description: Environment details, examples, or links that help explain the request.
  validations:
  required: false
