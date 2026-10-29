import { setDefaultTimeout } from "bun:test";

// Testes de integração esperam filas e transações reais: 60 s por teste.
setDefaultTimeout(60_000);
process.env.LOG_LEVEL ??= "silent";
