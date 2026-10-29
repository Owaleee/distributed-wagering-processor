import { type CanActivate, Injectable } from "@nestjs/common";

/**
 * Ponto de extensão da autenticação (ver ARCHITECTURE.md, "Autenticação").
 *
 * Hoje é no-op: o desafio não pontua autenticação e pede para não competir com correção
 * financeira. O desenho previsto: cada provedor é um client OIDC num IdP externo (Keycloak),
 * obtém token por client credentials, este guard valida o JWT pelo JWKS do IdP e compara o
 * claim do provedor com o `providerId` do corpo — quem não for dono do providerId recebe 403.
 * Health checks ficam abertos; mensagens da fila são canal interno confiável.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
