import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261029170000InitialSchema } from "./Migration20261029170000InitialSchema";

/**
 * Lista explícita de migrations, em ordem. Registrar aqui (em vez de descobrir
 * arquivos em disco) deixa a execução determinística no Bun e dentro do Docker.
 */
export const migrationsList: MigrationObject[] = [
  { name: "Migration20261029170000InitialSchema", class: Migration20261029170000InitialSchema },
];
