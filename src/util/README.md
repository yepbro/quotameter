# `src/util/` — cross-cutting helpers

Dependency-free utilities shared across layers: the clock/time-zone helper
(task 071), the structured redacting logger (task 072), and version-string
helpers (`version.ts`).

**Rule:** this layer is a leaf — it imports nothing from other `src/` modules.
Add a file here only when it is genuinely cross-cutting and dependency-free;
module-specific helpers stay inside their owning module.
