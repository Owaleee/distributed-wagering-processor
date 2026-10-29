import { Migration } from "@mikro-orm/migrations";

/**
 * Schema inicial. As garantias de unicidade, imutabilidade e não-negatividade ficam aqui,
 * no banco, e não só no código da aplicação: valem para qualquer instância e qualquer caminho de escrita.
 */
export class Migration20261029170000InitialSchema extends Migration {
  override up(): void {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      create table wallets (
        id          uuid primary key,
        player_id   uuid not null,
        currency    char(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20,2) not null check (balance >= 0),
        version     integer not null check (version >= 1),
        created_at  timestamptz not null,
        updated_at  timestamptz not null,
        constraint wallets_player_currency_key unique (player_id, currency),
        -- alvo da FK composta do ledger: garante que o lançamento usa a moeda da wallet
        constraint wallets_id_currency_key unique (id, currency)
      );
    `);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      create table wager_transactions (
        id                                uuid primary key,
        provider_id                       varchar(128) not null check (length(provider_id) > 0),
        external_transaction_id           varchar(128) not null check (length(external_transaction_id) > 0),
        idempotency_key                   varchar(256) not null check (length(idempotency_key) > 0),
        payload_hash                      char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id                         uuid not null references wallets (id) deferrable initially deferred,
        player_id                         uuid not null,
        round_id                          varchar(128) not null,
        game_id                           varchar(128) not null,
        kind                              varchar(16) not null
          check (kind in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        amount                            numeric(20,2) not null check (amount > 0),
        currency                          char(3) not null check (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id varchar(128),
        reference_transaction_id          uuid references wager_transactions (id) deferrable initially deferred,
        status                            varchar(24) not null
          check (status in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        failure_code                      varchar(64),
        -- saldo da wallet observado no processamento (devolvido no replay); moeda da wallet
        observed_balance                  numeric(20,2),
        observed_currency                 char(3),
        processed_at                      timestamptz,
        attempts                          integer not null default 0 check (attempts >= 0),
        next_attempt_at                   timestamptz,
        created_at                        timestamptz not null,
        updated_at                        timestamptz not null,

        -- idempotência por provedor: a key de um provedor nunca colide com a de outro
        constraint wager_transactions_provider_idempotency_key unique (provider_id, idempotency_key),
        constraint wager_transactions_provider_external_key unique (provider_id, external_transaction_id),
        -- REFUND e ROLLBACK exigem referência
        constraint wager_transactions_reference_required
          check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null),
        -- rejeição e falha sempre carregam um código; os demais estados nunca
        constraint wager_transactions_failure_code_consistency
          check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null)),
        -- estados terminais têm data de conclusão
        constraint wager_transactions_terminal_has_processed_at
          check (status not in ('PROCESSED', 'REJECTED', 'FAILED') or processed_at is not null),
        constraint wager_transactions_observed_balance_pair
          check ((observed_balance is null) = (observed_currency is null)),
        -- pendente de referência precisa de agenda de reprocessamento
        constraint wager_transactions_pending_reference_scheduled
          check (status <> 'PENDING_REFERENCE' or next_attempt_at is not null)
      );
    `);
    // Uma referência só pode ser revertida uma vez (de qualquer tipo; ver ARCHITECTURE.md).
    this.addSql(`
      create unique index wager_transactions_single_reversal_idx
        on wager_transactions (reference_transaction_id)
        where kind in ('REFUND', 'ROLLBACK') and status = 'PROCESSED';
    `);
    // Fila do worker de referências pendentes.
    this.addSql(`
      create index wager_transactions_pending_reference_idx
        on wager_transactions (next_attempt_at)
        where status = 'PENDING_REFERENCE';
    `);
    this.addSql(`create index wager_transactions_wallet_idx on wager_transactions (wallet_id, created_at);`);

    // Transações: campos de negócio imutáveis, estados terminais definitivos e nada é apagado.
    this.addSql(`
      create function wager_transactions_guard() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'wager_transactions é append-only: DELETE não permitido (id %)', old.id
            using errcode = 'restrict_violation';
        end if;
        if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
          raise exception 'transação % está em estado terminal (%) e não pode ser alterada', old.id, old.status
            using errcode = 'restrict_violation';
        end if;
        if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key, new.payload_hash,
            new.wallet_id, new.player_id, new.round_id, new.game_id, new.kind, new.amount, new.currency,
            new.reference_external_transaction_id, new.created_at)
           is distinct from
           (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key, old.payload_hash,
            old.wallet_id, old.player_id, old.round_id, old.game_id, old.kind, old.amount, old.currency,
            old.reference_external_transaction_id, old.created_at) then
          raise exception 'campos de negócio da transação % são imutáveis', old.id
            using errcode = 'restrict_violation';
        end if;
        return new;
      end;
      $$;
    `);
    this.addSql(`
      create trigger wager_transactions_guard_trg
        before update or delete on wager_transactions
        for each row execute function wager_transactions_guard();
    `);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      create table wallet_ledger_entries (
        id              uuid primary key,
        seq             bigint generated always as identity,
        wallet_id       uuid not null,
        transaction_id  uuid not null references wager_transactions (id) deferrable initially deferred,
        direction       varchar(8) not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20,2) not null check (amount > 0),
        currency        char(3) not null,
        balance_before  numeric(20,2) not null check (balance_before >= 0),
        balance_after   numeric(20,2) not null check (balance_after >= 0),
        wallet_version  integer not null check (wallet_version >= 1),
        created_at      timestamptz not null,

        constraint wallet_ledger_entries_seq_key unique (seq),
        -- moeda do lançamento = moeda da wallet
        constraint wallet_ledger_entries_wallet_fk
          foreign key (wallet_id, currency) references wallets (id, currency) deferrable initially deferred,
        -- no máximo um lançamento por transação por wallet
        constraint wallet_ledger_entries_transaction_wallet_key unique (transaction_id, wallet_id),
        -- um lançamento por versão: dois movimentos calculados do mesmo estado (lost update) colidem aqui
        constraint wallet_ledger_entries_wallet_version_key unique (wallet_id, wallet_version),
        -- aritmética do lançamento: antes ± valor = depois
        constraint wallet_ledger_entries_balanced check (
          (direction = 'CREDIT' and balance_after = balance_before + amount) or
          (direction = 'DEBIT'  and balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`create index wallet_ledger_entries_wallet_seq_idx on wallet_ledger_entries (wallet_id, seq);`);

    // Ledger imutável: bloqueia UPDATE, DELETE e TRUNCATE.
    this.addSql(`
      create function wallet_ledger_entries_immutable() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet_ledger_entries é imutável: % não permitido', tg_op
          using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_immutable_trg
        before update or delete on wallet_ledger_entries
        for each row execute function wallet_ledger_entries_immutable();
    `);
    this.addSql(`
      create trigger wallet_ledger_entries_no_truncate_trg
        before truncate on wallet_ledger_entries
        for each statement execute function wallet_ledger_entries_immutable();
    `);

    // Saldo ↔ ledger: verificado no COMMIT (trigger adiado), depois que wallet e lançamento foram gravados.
    // - saldo inicial > 0 exige o lançamento de abertura (versão 1);
    // - toda mudança de saldo incrementa a versão em exatamente 1 e tem o lançamento correspondente;
    // - sem mudança de saldo, a versão não muda; id, player, moeda e criação são imutáveis.
    this.addSql(`
      create function wallets_assert_ledger() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          if new.version <> 1 then
            raise exception 'wallet % deve nascer na versão 1', new.id using errcode = 'check_violation';
          end if;
          if new.balance > 0 and not exists (
            select 1 from wallet_ledger_entries e
             where e.wallet_id = new.id and e.wallet_version = 1
               and e.balance_before = 0 and e.balance_after = new.balance
          ) then
            raise exception 'wallet %: saldo inicial sem lançamento de abertura', new.id using errcode = 'check_violation';
          end if;
          return null;
        end if;

        if (new.id, new.player_id, new.currency, new.created_at) is distinct from
           (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'wallet %: id, player, moeda e data de criação são imutáveis', old.id using errcode = 'check_violation';
        end if;
        if new.balance = old.balance then
          if new.version <> old.version then
            raise exception 'wallet %: versão só muda quando o saldo muda', old.id using errcode = 'check_violation';
          end if;
          return null;
        end if;
        if new.version <> old.version + 1 then
          raise exception 'wallet %: mudança de saldo deve incrementar a versão em 1', old.id using errcode = 'check_violation';
        end if;
        if not exists (
          select 1 from wallet_ledger_entries e
           where e.wallet_id = new.id and e.wallet_version = new.version
             and e.balance_before = old.balance and e.balance_after = new.balance
        ) then
          raise exception 'wallet %: mudança de saldo sem lançamento no ledger', old.id using errcode = 'check_violation';
        end if;
        return null;
      end;
      $$;
    `);
    this.addSql(`
      create constraint trigger wallets_assert_ledger_trg
        after insert or update on wallets
        deferrable initially deferred
        for each row execute function wallets_assert_ledger();
    `);
    this.addSql(`
      create function wallets_no_delete() returns trigger language plpgsql as $$
      begin
        raise exception 'wallets não podem ser apagadas (id %)', old.id using errcode = 'restrict_violation';
      end;
      $$;
    `);
    this.addSql(`
      create trigger wallets_no_delete_trg before delete on wallets
        for each row execute function wallets_no_delete();
    `);

    // ------------------------------------------------------------------ inbox / outbox
    this.addSql(`
      create table inbox_messages (
        consumer_name  varchar(128) not null,
        message_id     varchar(256) not null,
        payload_hash   char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at    timestamptz not null,
        processed_at   timestamptz,
        constraint inbox_messages_pkey primary key (consumer_name, message_id)
      );
    `);
    this.addSql(`
      create table outbox_messages (
        id               uuid primary key,
        aggregate_id     varchar(128) not null,
        event_type       varchar(128) not null,
        payload          jsonb not null,
        occurred_at      timestamptz not null,
        attempts         integer not null default 0 check (attempts >= 0),
        next_attempt_at  timestamptz not null,
        published_at     timestamptz,
        last_error       varchar(512)
      );
    `);
    this.addSql(`
      create index outbox_messages_pending_idx on outbox_messages (next_attempt_at)
        where published_at is null;
    `);
  }

  override down(): void {
    this.addSql(`drop table if exists outbox_messages;`);
    this.addSql(`drop table if exists inbox_messages;`);
    this.addSql(`drop table if exists wallet_ledger_entries;`);
    this.addSql(`drop table if exists wager_transactions;`);
    this.addSql(`drop table if exists wallets;`);
    this.addSql(`drop function if exists wallets_no_delete();`);
    this.addSql(`drop function if exists wallets_assert_ledger();`);
    this.addSql(`drop function if exists wallet_ledger_entries_immutable();`);
    this.addSql(`drop function if exists wager_transactions_guard();`);
  }
}
