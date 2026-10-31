/**
 * Portas para os processos e o proxy dos testes, que precisam REABRIR a mesma porta
 * (reinício de uma instância depois de SIGKILL, volta do "banco" depois da queda simulada).
 *
 * Elas são sorteadas ABAIXO de 32768 de propósito: no Linux, a faixa 32768–60999
 * (`ip_local_port_range`) é usada pelo próprio sistema como porta local das conexões de saída.
 * Uma porta sorteada ali pode ser ocupada a qualquer momento por uma conexão comum com o
 * PostgreSQL ou o SQS, e a instância não sobe ("Is port in use?"). No macOS e no Windows essa
 * faixa começa em 49152, então 20000–32000 também fica fora dela. Abaixo de 32768, só um serviço
 * escutando poderia ocupar a porta, e isso é conferido antes de devolver.
 */
const MIN_PORT = 20_000;
const MAX_PORT = 32_000;

/** A porta pode ser aberta agora (em todas as interfaces, como a aplicação faz)? */
export function isPortFree(port: number): boolean {
  try {
    const server = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

/** Primeira de `count` portas consecutivas livres, sorteada fora da faixa de portas de saída. */
export function freePortRange(count = 1): number {
  for (let attempt = 0; attempt < 500; attempt++) {
    const base = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT - count));
    let free = true;
    for (let i = 0; i < count && free; i++) free = isPortFree(base + i);
    if (free) return base;
  }
  throw new Error(`nenhuma faixa de ${count} porta(s) livre entre ${MIN_PORT} e ${MAX_PORT}`);
}
