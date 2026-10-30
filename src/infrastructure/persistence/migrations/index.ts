import type { MigrationObject } from "@mikro-orm/core";
import { Migration20261029170000InitialSchema } from "./Migration20261029170000InitialSchema";
import { Migration20261029190000PendingReferenceWorker } from "./Migration20261029190000PendingReferenceWorker";
import { Migration20261030010000OutboxRelayOrder } from "./Migration20261030010000OutboxRelayOrder";
import { Migration20261030020000ActiveWinLookup } from "./Migration20261030020000ActiveWinLookup";

/**
 * Lista explícita de migrations, em ordem. Registrar aqui (em vez de descobrir
 * arquivos em disco) deixa a execução determinística no Bun e dentro do Docker.
 */
export const migrationsList: MigrationObject[] = [
  { name: "Migration20261029170000InitialSchema", class: Migration20261029170000InitialSchema },
  { name: "Migration20261029190000PendingReferenceWorker", class: Migration20261029190000PendingReferenceWorker },
  { name: "Migration20261030010000OutboxRelayOrder", class: Migration20261030010000OutboxRelayOrder },
  { name: "Migration20261030020000ActiveWinLookup", class: Migration20261030020000ActiveWinLookup },
];
