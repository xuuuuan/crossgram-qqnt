// Vite's import-glob declarations refer to a browser Worker even in this Node-only project.
type Worker = import('node:worker_threads').Worker
