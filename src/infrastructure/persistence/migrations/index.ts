import type { MigrationObject } from "@mikro-orm/core";

/**
 * Lista explícita de migrations, em ordem. Registrar aqui (em vez de descobrir
 * arquivos em disco) deixa a execução determinística no Bun e dentro do Docker.
 */
export const migrationsList: MigrationObject[] = [];
