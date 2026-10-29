import type { Socket, TCPSocketListener } from "bun";

export interface TcpProxy {
  readonly port: number;
  /**
   * Simula o banco caindo: fecha a porta e derruba o lado do banco. As conexões já abertas pela
   * aplicação NÃO são avisadas (como numa queda de rede): ela só descobre ao tentar usá-las.
   */
  stop(): void;
  /** Volta a aceitar conexões na mesma porta. */
  start(): void;
  /** Encerra tudo (fim do teste). */
  close(): void;
}

interface Pair {
  upstream?: Socket<Pair>;
  client?: Socket<Pair>;
  pending: Uint8Array[];
  /** O lado do banco caiu: o próximo envio da aplicação encerra a conexão. */
  dead?: boolean;
}

/** Proxy TCP mínimo para simular indisponibilidade do PostgreSQL nos testes. */
export function startTcpProxy(target: { hostname: string; port: number }): TcpProxy {
  let listener: TCPSocketListener<Pair> | undefined;
  let port = 0;
  const clients = new Set<Socket<Pair>>();
  const upstreams = new Set<Socket<Pair>>();
  let down = false;

  const listen = () => {
    listener = Bun.listen<Pair>({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(client) {
          const pair: Pair = { client, pending: [] };
          client.data = pair;
          clients.add(client);
          void Bun.connect<Pair>({
            hostname: target.hostname,
            port: target.port,
            data: pair,
            socket: {
              open(upstream) {
                pair.upstream = upstream;
                upstreams.add(upstream);
                for (const chunk of pair.pending) upstream.write(chunk);
                pair.pending = [];
              },
              data(_s, chunk) {
                pair.client?.write(chunk);
              },
              close(upstream) {
                upstreams.delete(upstream);
                if (down) pair.dead = true;
                else pair.client?.end();
              },
              error() {
                pair.client?.end();
              },
            },
          }).catch(() => client.end());
        },
        data(client, chunk) {
          const pair = client.data;
          if (pair.dead) client.terminate();
          else if (pair.upstream) pair.upstream.write(chunk);
          else pair.pending.push(new Uint8Array(chunk));
        },
        close(client) {
          clients.delete(client);
          client.data.upstream?.end();
        },
      },
    });
    port = listener.port;
  };

  const stop = () => {
    down = true;
    listener?.stop(false);
    listener = undefined;
    for (const s of upstreams) s.terminate();
  };

  listen();
  return {
    get port() {
      return port;
    },
    stop,
    start() {
      down = false;
      if (listener === undefined) listen();
    },
    close() {
      stop();
      for (const s of clients) s.terminate();
    },
  };
}
