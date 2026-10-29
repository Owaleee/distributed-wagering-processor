import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  /** Processo vivo: não toca dependências (um banco fora do ar não deve reiniciar o processo). */
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}
