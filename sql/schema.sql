-- Accounting agents sample: the books of one small company, and one Postgres
-- role per agent. What each agent may read or write is decided here, with
-- grants, not in its prompt. A trigger records every write with the role
-- that made it.

create table suppliers (
  id     int primary key,
  name   text not null,
  tax_id text not null unique           -- RUC in Panama
);

create table customers (
  id    int primary key,
  name  text not null,
  email text not null
);

-- Documents as they arrive (email bodies, OCR text). Untrusted input.
create table inbox_documents (
  id          int primary key,
  received_at date not null,
  sender      text not null,
  body        text not null,
  processed   boolean not null default false
);

create table supplier_invoices (
  id          serial primary key,
  supplier_id int not null references suppliers(id),
  number      text not null,
  issued_on   date not null,
  due_on      date not null,
  subtotal    numeric(12,2) not null check (subtotal > 0),
  tax         numeric(12,2) not null check (tax >= 0),   -- ITBMS 7%
  total       numeric(12,2) not null,
  document_id int references inbox_documents(id),
  status      text not null default 'open' check (status in ('open', 'scheduled', 'paid')),
  unique (supplier_id, number),
  check (total = subtotal + tax)
);

-- The payables agent proposes; a person approves. No agent can approve.
create table payment_proposals (
  id                  serial primary key,
  supplier_invoice_id int not null references supplier_invoices(id) unique,
  pay_on              date not null,
  amount              numeric(12,2) not null check (amount > 0),
  status              text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  approved_by         text
);

create table customer_orders (
  id          int primary key,
  customer_id int not null references customers(id),
  delivered_on date not null,
  description text not null,
  subtotal    numeric(12,2) not null check (subtotal > 0),
  invoiced    boolean not null default false
);

create table customer_invoices (
  id          serial primary key,
  number      text not null unique,
  customer_id int not null references customers(id),
  order_id    int not null references customer_orders(id) unique,
  issued_on   date not null,
  due_on      date not null,
  subtotal    numeric(12,2) not null,
  tax         numeric(12,2) not null,
  total       numeric(12,2) not null,
  paid        boolean not null default false,
  check (total = subtotal + tax)
);

-- Collection messages are drafts until a person sends them.
create table reminder_drafts (
  id                  serial primary key,
  customer_invoice_id int not null references customer_invoices(id),
  body                text not null,
  status              text not null default 'draft' check (status in ('draft', 'sent', 'discarded'))
);

create table bank_lines (
  id          int primary key,
  posted_on   date not null,
  description text not null,
  amount      numeric(12,2) not null      -- positive: money in; negative: money out
);

create table reconciliations (
  bank_line_id        int primary key references bank_lines(id),
  customer_invoice_id int references customer_invoices(id),
  supplier_invoice_id int references supplier_invoices(id),
  check (num_nonnulls(customer_invoice_id, supplier_invoice_id) = 1)
);

-- What an agent couldn't settle with evidence goes to a person.
create table escalations (
  id         serial primary key,
  agent      text not null default current_user,
  subject    text not null,
  reason     text not null,
  status     text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now()
);

-- Every tool call, written by the harness (not by the agents).
create table agent_actions (
  id         serial primary key,
  run_id     text not null,
  agent      text not null,
  tool       text not null,
  input      jsonb not null,
  ok         boolean not null,
  result     jsonb,
  created_at timestamptz not null default now()
);

-- Every write to the books, with the role that made it. Written by a trigger.
create table audit_log (
  id         serial primary key,
  actor      text not null,
  table_name text not null,
  action     text not null,
  row_data   jsonb not null,
  created_at timestamptz not null default now()
);

create function audit() returns trigger
language plpgsql security definer as $$
begin
  insert into audit_log (actor, table_name, action, row_data)
  -- Inside a security definer function current_user is the owner; the role
  -- the agent runs as is still in the 'role' setting.
  values (coalesce(nullif(current_setting('role'), 'none'), session_user), tg_table_name, lower(tg_op), to_jsonb(coalesce(new, old)));
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['inbox_documents', 'supplier_invoices', 'payment_proposals', 'customer_orders',
                           'customer_invoices', 'reminder_drafts', 'reconciliations', 'escalations'] loop
    execute format('create trigger audit_%1$s after insert or update or delete on %1$s for each row execute function audit()', t);
  end loop;
end $$;

-- ── One role per agent ────────────────────────────────────────────────────

do $$
declare r text;
begin
  foreach r in array array['agent_intake', 'agent_archive', 'agent_payables', 'agent_billing',
                           'agent_collections', 'agent_reconciliation', 'agent_orchestrator'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin nobypassrls', r);
    end if;
  end loop;
end $$;

-- Everyone can read the books and raise an escalation. Nobody can touch the
-- audit trail or the action log.
grant select on suppliers, customers, inbox_documents, supplier_invoices, payment_proposals,
                customer_orders, customer_invoices, reminder_drafts, bank_lines, reconciliations,
                escalations
  to agent_intake, agent_archive, agent_payables, agent_billing,
     agent_collections, agent_reconciliation, agent_orchestrator;
grant insert (subject, reason) on escalations
  to agent_intake, agent_archive, agent_payables, agent_billing,
     agent_collections, agent_reconciliation, agent_orchestrator;
grant usage on sequence escalations_id_seq
  to agent_intake, agent_archive, agent_payables, agent_billing,
     agent_collections, agent_reconciliation, agent_orchestrator;

-- Intake: records supplier invoices and marks documents processed.
grant insert on supplier_invoices to agent_intake;
grant usage on sequence supplier_invoices_id_seq to agent_intake;
grant update (processed) on inbox_documents to agent_intake;

-- Payables: proposes payments. Only (pay_on, amount, supplier_invoice_id) —
-- it can't write status or approved_by, so it can't approve its own proposal.
grant insert (supplier_invoice_id, pay_on, amount) on payment_proposals to agent_payables;
grant usage on sequence payment_proposals_id_seq to agent_payables;
grant update (status) on supplier_invoices to agent_payables;

-- Billing: issues customer invoices for delivered orders.
grant insert on customer_invoices to agent_billing;
grant usage on sequence customer_invoices_id_seq to agent_billing;
grant update (invoiced) on customer_orders to agent_billing;

-- Collections: drafts reminders. It can't mark them sent.
grant insert (customer_invoice_id, body) on reminder_drafts to agent_collections;
grant usage on sequence reminder_drafts_id_seq to agent_collections;

-- Reconciliation: matches bank lines and marks customer invoices paid.
grant insert on reconciliations to agent_reconciliation;
grant update (paid) on customer_invoices to agent_reconciliation;
grant update (status) on supplier_invoices to agent_reconciliation;

-- Archive and orchestrator: read-only (plus escalations).
